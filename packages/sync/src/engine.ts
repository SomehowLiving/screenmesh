import * as Y from "yjs";
import {
  DEFAULT_HOP_LIMIT,
  envelopeFromJson,
  envelopeToJson,
  fromBase64,
  toBase64,
  type CarryBundlePayload,
  type ContinueOnDevicePayload,
  type CreateObjectPayload,
  type Delivery,
  type DeliveryBundle,
  type Device,
  type EnvelopeJson,
  type MeshObject,
  type MeshObjectType,
  type ObjectRefPayload,
  type Operation,
  type OperationType,
  type PresenceEntry,
  type RevokeDevicePayload,
  type RotateKeyPayload,
  type SendOptions,
  type SendToDevicePayload,
  type TextContent,
  type UpdateObjectPayload,
  type YjsUpdatePayload,
} from "@screenmesh/protocol";
import {
  exportRawWorkspaceKey,
  generateWorkspaceKey,
  importEncryptionPublicKey,
  importPublicKey,
  importRawWorkspaceKey,
  openEnvelope,
  sealEnvelope,
  unwrapKeyBytes,
  wrapKeyBytes,
  type DeviceIdentity,
} from "@screenmesh/crypto";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { WebSocketRelayTransport } from "@screenmesh/transport";

const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often to sweep expired objects/bundles and advance store-carry-forward. */
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

/** Object types whose text is collaboratively editable via Yjs. */
const EDITABLE_TYPES = new Set(["text", "code", "link"]);

/** Apply `next` to a Y.Text as a minimal splice (common prefix/suffix). */
function applyTextDiff(ytext: Y.Text, next: string): void {
  const prev = ytext.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) {
    start++;
  }
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  if (endPrev > start) ytext.delete(start, endPrev - start);
  if (endNext > start) ytext.insert(start, next.slice(start, endNext));
}

/** An optional direct (peer-to-peer) byte channel, e.g. WebRTC. */
export interface DirectChannel {
  /** Returns true if the bytes were handed to an OPEN direct channel. */
  trySend(peerId: string, data: Uint8Array): boolean;
  onMessage(handler: (data: Uint8Array) => void): void;
}

export interface EngineConfig {
  db: ScreenMeshDb;
  identity: DeviceIdentity;
  workspaceId: string;
  /** Epoch-0 workspace key (from the pairing QR). */
  workspaceKey: CryptoKey;
  /** Only this device may rotate keys or revoke devices. */
  ownerDeviceId: string;
  transport: WebSocketRelayTransport;
  /** Optional peer-to-peer channel tried before the relay (WebRTC). */
  direct?: DirectChannel;
  now?: () => number;
  /** Override the periodic sweep cadence (tests use a short interval). */
  sweepIntervalMs?: number;
}

/**
 * MeshEngine ties the layers together (docs/Architecture.md §4):
 * UI action → oplog + local store → encrypt/envelope → transport,
 * and the reverse on receive: verify → decrypt → apply → acknowledge.
 * When the transport is down, envelopes wait in the IndexedDB outbox
 * and drain on reconnect (the relay queues for offline recipients too).
 */
export class MeshEngine {
  private seq = 0;
  private readonly peerKeys = new Map<string, CryptoKey>();
  /** Workspace keys by epoch; old epochs stay decryptable. */
  private readonly keys = new Map<number, CryptoKey>();
  private currentEpoch = 0;
  /** In-memory Yjs docs for collaboratively edited objects. */
  private readonly ydocs = new Map<string, Y.Doc>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: EngineConfig) {
    this.keys.set(0, cfg.workspaceKey);
  }

  private get me(): string {
    return this.cfg.identity.deviceId;
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  async start(): Promise<void> {
    const seqSetting = await this.cfg.db.settings.get("mySeq");
    this.seq = typeof seqSetting?.value === "number" ? seqSetting.value : 0;

    const rotated = await this.cfg.db.settings.get("rotatedKeys");
    for (const entry of (rotated?.value as Array<{ epoch: number; key: CryptoKey }>) ?? []) {
      this.keys.set(entry.epoch, entry.key);
      if (entry.epoch > this.currentEpoch) this.currentEpoch = entry.epoch;
    }
    await this.cfg.db.seen
      .where("seenAt")
      .below(this.now() - SEEN_RETENTION_MS)
      .delete();

    const transport = this.cfg.transport;
    const incoming = (data: Uint8Array) => {
      void this.handleIncoming(data).catch((err) => {
        console.error("screenmesh: failed to process incoming envelope", err);
      });
    };
    transport.onMessage(incoming);
    this.cfg.direct?.onMessage(incoming);
    transport.subscribePresence((devices) => {
      void this.applyPresence(devices);
    });
    transport.subscribeStatus((status) => {
      if (status === "connected") void this.drainOutbox();
    });
    await transport.open();

    void this.periodicSweep();
    this.sweepTimer = setInterval(
      () => void this.periodicSweep(),
      this.cfg.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.cfg.transport.disconnect();
  }

  /** Create an object locally and send it to each recipient device. */
  async sendObject(
    input: { type: MeshObjectType; content: unknown },
    recipientIds: string[],
    options: SendOptions = {},
  ): Promise<MeshObject> {
    const now = this.now();
    const object: MeshObject = {
      id: crypto.randomUUID(),
      workspaceId: this.cfg.workspaceId,
      type: input.type,
      content: input.content,
      createdBy: this.me,
      createdAt: now,
      updatedAt: now,
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    };
    await this.cfg.db.objects.add(object);

    // Editable objects get a Yjs doc seeded by the CREATOR only; everyone
    // else receives the seeded state, so concurrent edits merge cleanly.
    let seedUpdateB64: string | null = null;
    if (EDITABLE_TYPES.has(object.type)) {
      const doc = new Y.Doc();
      const text = (object.content as TextContent | null)?.text ?? "";
      doc.getText("text").insert(0, text);
      this.ydocs.set(object.id, doc);
      await this.persistDoc(object.id, doc);
      seedUpdateB64 = toBase64(Y.encodeStateAsUpdate(doc));
    }

    for (const recipientId of recipientIds) {
      const delivery: Delivery = {
        id: crypto.randomUUID(),
        objectId: object.id,
        sourceDeviceId: this.me,
        destinationDeviceId: recipientId,
        status: "queued",
        createdAt: now,
        ...(Object.keys(options).length > 0 ? { options } : {}),
      };
      await this.cfg.db.deliveries.add(delivery);
      const ops: Operation<unknown>[] = [
        this.makeOp("CREATE_OBJECT", object.id, {
          object,
        } satisfies CreateObjectPayload),
      ];
      if (seedUpdateB64 !== null) {
        ops.push(
          this.makeOp("YJS_UPDATE", object.id, {
            objectId: object.id,
            updateB64: seedUpdateB64,
          } satisfies YjsUpdatePayload),
        );
      }
      ops.push(
        this.makeOp("SEND_TO_DEVICE", object.id, {
          objectId: object.id,
          options,
        } satisfies SendToDevicePayload),
      );
      // Real object deliveries are carry-eligible: if this recipient is
      // unreachable directly, another online device may later carry the
      // encrypted bundle on our behalf (docs/Architecture.md §2).
      const sentLive = await this.sendOps(recipientId, ops, DEFAULT_HOP_LIMIT);
      if (sentLive) {
        await this.cfg.db.deliveries.update(delivery.id, { status: "sending" });
      }
    }
    return object;
  }

  /**
   * Collaborative text editing: apply the new text as a minimal splice on
   * the object's Y.Text and broadcast the full doc state (idempotent and
   * order-independent — concurrent edits on other devices merge instead
   * of overwriting).
   */
  async editText(objectId: string, newText: string): Promise<void> {
    const object = await this.cfg.db.objects.get(objectId);
    if (!object || !EDITABLE_TYPES.has(object.type)) return;
    const doc = await this.docFor(objectId);
    doc.transact(() => applyTextDiff(doc.getText("text"), newText));
    await this.persistDoc(objectId, doc);
    await this.cfg.db.objects.update(objectId, {
      content: { text: doc.getText("text").toString() },
      updatedAt: this.now(),
    });
    await this.broadcastOps([
      this.makeOp("YJS_UPDATE", objectId, {
        objectId,
        updateB64: toBase64(Y.encodeStateAsUpdate(doc)),
      } satisfies YjsUpdatePayload),
    ]);
  }

  /** Last-write-wins content replacement (checklist toggles, etc.). */
  async updateObjectContent(objectId: string, content: unknown): Promise<void> {
    const now = this.now();
    await this.cfg.db.objects.update(objectId, { content, updatedAt: now });
    await this.broadcastOps([
      this.makeOp("UPDATE_OBJECT", objectId, {
        objectId,
        content,
        updatedAt: now,
      } satisfies UpdateObjectPayload),
    ]);
  }

  /**
   * Hand an object off to another device: deliver it (idempotent if the
   * device already has it) and ask that device to open it for editing.
   */
  async continueOnDevice(objectId: string, deviceId: string): Promise<void> {
    const object = await this.cfg.db.objects.get(objectId);
    if (!object) return;
    const ops: Operation<unknown>[] = [
      this.makeOp("CREATE_OBJECT", objectId, {
        object,
      } satisfies CreateObjectPayload),
    ];
    if (EDITABLE_TYPES.has(object.type)) {
      const doc = await this.docFor(objectId);
      ops.push(
        this.makeOp("YJS_UPDATE", objectId, {
          objectId,
          updateB64: toBase64(Y.encodeStateAsUpdate(doc)),
        } satisfies YjsUpdatePayload),
      );
    }
    ops.push(
      this.makeOp("SEND_TO_DEVICE", objectId, {
        objectId,
        options: {},
      } satisfies SendToDevicePayload),
      this.makeOp("CONTINUE_ON_DEVICE", objectId, {
        objectId,
      } satisfies ContinueOnDevicePayload),
    );
    await this.sendOps(deviceId, ops, DEFAULT_HOP_LIMIT);
  }

  /** Recipient-side: mark an object opened and notify the sender. */
  async markOpened(objectId: string): Promise<void> {
    const object = await this.cfg.db.objects.get(objectId);
    if (!object || object.createdBy === this.me) return;
    const delivery = await this.cfg.db.deliveries
      .where("objectId")
      .equals(objectId)
      .and((d) => d.destinationDeviceId === this.me)
      .first();
    if (!delivery || delivery.status === "opened" || delivery.status === "pending") return;
    await this.cfg.db.deliveries.update(delivery.id, {
      status: "opened",
      openedAt: this.now(),
    });
    await this.sendOps(object.createdBy, [
      this.makeOp("MARK_OPENED", objectId, { objectId } satisfies ObjectRefPayload),
    ]);
    if (delivery.options?.deleteAfterOpening) {
      await this.deleteObjectLocal(objectId);
    }
  }

  /**
   * Recipient-side: accept a requireConfirmation delivery — makes it act
   * like a normal delivery from here on (status -> delivered, sender
   * notified) so open/copy/edit actions become available in the UI.
   */
  async acceptObject(objectId: string): Promise<void> {
    const delivery = await this.cfg.db.deliveries
      .where("objectId")
      .equals(objectId)
      .and((d) => d.destinationDeviceId === this.me && d.status === "pending")
      .first();
    if (!delivery) return;
    const now = this.now();
    await this.cfg.db.deliveries.update(delivery.id, {
      status: "delivered",
      deliveredAt: now,
    });
    await this.sendOps(delivery.sourceDeviceId, [
      this.makeOp("MARK_DELIVERED", objectId, { objectId } satisfies ObjectRefPayload),
    ]);
  }

  /**
   * Recipient-side: decline a requireConfirmation delivery. The object is
   * removed locally and the sender is told so their delivery status
   * reflects it, without ever executing/opening the content.
   */
  async rejectObject(objectId: string): Promise<void> {
    const delivery = await this.cfg.db.deliveries
      .where("objectId")
      .equals(objectId)
      .and((d) => d.destinationDeviceId === this.me && d.status === "pending")
      .first();
    if (!delivery) return;
    await this.sendOps(delivery.sourceDeviceId, [
      this.makeOp("REJECT_OBJECT", objectId, { objectId } satisfies ObjectRefPayload),
    ]);
    await this.deleteObjectLocal(objectId);
  }

  /** Local-only delete (MVP): removes the object and its delivery rows. */
  async deleteObjectLocal(objectId: string): Promise<void> {
    await this.cfg.db.deliveries.where("objectId").equals(objectId).delete();
    await this.purgeObject(objectId);
  }

  /** Removes the object + its Yjs doc WITHOUT touching delivery rows —
   *  used when a delivery's final status (expired, opened, ...) needs to
   *  stay visible after the object content itself is gone. */
  private async purgeObject(objectId: string): Promise<void> {
    await this.cfg.db.objects.delete(objectId);
    await this.cfg.db.ydocs.delete(objectId);
    this.ydocs.get(objectId)?.destroy();
    this.ydocs.delete(objectId);
  }

  private async docFor(objectId: string): Promise<Y.Doc> {
    const cached = this.ydocs.get(objectId);
    if (cached) return cached;
    const doc = new Y.Doc();
    const persisted = await this.cfg.db.ydocs.get(objectId);
    if (persisted) Y.applyUpdate(doc, persisted.state);
    this.ydocs.set(objectId, doc);
    return doc;
  }

  private async persistDoc(objectId: string, doc: Y.Doc): Promise<void> {
    await this.cfg.db.ydocs.put({ objectId, state: Y.encodeStateAsUpdate(doc) });
  }

  /** Send the same ops to every other device in the workspace. */
  private async broadcastOps(ops: Operation<unknown>[]): Promise<void> {
    const others = (await this.cfg.db.devices.toArray()).filter(
      (d) => d.id !== this.me,
    );
    for (const device of others) {
      await this.sendOps(device.id, ops);
    }
  }

  /**
   * Owner-side revocation: tell the remaining devices and drop the device
   * locally. Relay enforcement (rejecting the revoked device) happens via
   * the HTTP revoke endpoint — see docs/Security.md §2.
   */
  async revokeDevice(deviceId: string): Promise<void> {
    const others = (await this.cfg.db.devices.toArray()).filter(
      (d) => d.id !== this.me && d.id !== deviceId,
    );
    for (const device of others) {
      await this.sendOps(device.id, [
        this.makeOp("REVOKE_DEVICE", undefined, {
          deviceId,
        } satisfies RevokeDevicePayload),
      ]);
    }
    await this.cfg.db.devices.delete(deviceId);
    this.peerKeys.delete(deviceId);
  }

  /**
   * Owner-side key rotation (docs/Security.md §5): generate a fresh
   * workspace key and send it to each remaining device wrapped via X25519
   * ECDH — the revoked device cannot unwrap it, so everything sent after
   * rotation is cryptographically out of its reach. Old epochs are kept
   * so history and in-flight envelopes stay readable.
   */
  async rotateWorkspaceKey(): Promise<number> {
    if (this.me !== this.cfg.ownerDeviceId) {
      throw new Error("only the workspace owner can rotate keys");
    }
    const newEpoch = this.currentEpoch + 1;
    const newKey = await generateWorkspaceKey();
    const rawKey = await exportRawWorkspaceKey(newKey);

    const others = (await this.cfg.db.devices.toArray()).filter(
      (d) => d.id !== this.me,
    );
    for (const device of others) {
      if (!device.encryptionKey) {
        console.warn(
          `screenmesh: device ${device.name} has no encryption key (paired before rotation support) — it will lose access after rotation; re-pair it`,
        );
        continue;
      }
      const theirPublic = await importEncryptionPublicKey(device.encryptionKey);
      const wrapped = await wrapKeyBytes(
        this.cfg.identity.encryptionPrivateKey,
        theirPublic,
        rawKey,
      );
      // Sent under the CURRENT epoch (outer layer); the new key itself is
      // protected by the pairwise ECDH wrap, not by the old workspace key.
      await this.sendOps(device.id, [
        this.makeOp("ROTATE_KEY", undefined, {
          epoch: newEpoch,
          wrappedKeyB64: wrapped.wrappedKeyB64,
          nonceB64: wrapped.nonceB64,
        } satisfies RotateKeyPayload),
      ]);
    }

    await this.adoptKey(newEpoch, newKey);
    return newEpoch;
  }

  private async adoptKey(epoch: number, key: CryptoKey): Promise<void> {
    this.keys.set(epoch, key);
    if (epoch > this.currentEpoch) this.currentEpoch = epoch;
    const rotated = [...this.keys.entries()]
      .filter(([e]) => e > 0)
      .map(([e, k]) => ({ epoch: e, key: k }));
    await this.cfg.db.settings.put({ key: "rotatedKeys", value: rotated });
  }

  // --- internals ---

  private makeOp<T>(
    type: OperationType,
    objectId: string | undefined,
    payload: T,
  ): Operation<T> {
    return {
      operationId: crypto.randomUUID(),
      deviceId: this.me,
      workspaceId: this.cfg.workspaceId,
      type,
      ...(objectId !== undefined ? { objectId } : {}),
      timestamp: this.now(),
      payload,
    };
  }

  /**
   * Seal ops into an envelope; send live or queue in the outbox.
   * `hopLimit` bounds store-carry-forward fan-out for THIS bundle if it
   * ends up queued (0 = never offered to a carrier — appropriate for
   * acks/control ops, which are cheap to just re-send once back online).
   */
  private async sendOps(
    recipientId: string,
    ops: Operation<unknown>[],
    hopLimit = 0,
  ): Promise<boolean> {
    this.seq += 1;
    await this.cfg.db.settings.put({ key: "mySeq", value: this.seq });

    const workspaceKey = this.keys.get(this.currentEpoch);
    if (!workspaceKey) throw new Error(`missing workspace key epoch ${this.currentEpoch}`);
    const plaintext = new TextEncoder().encode(JSON.stringify({ ops }));
    const envelope = await sealEnvelope({
      identity: this.cfg.identity,
      recipientDeviceId: recipientId,
      workspaceId: this.cfg.workspaceId,
      workspaceKey,
      plaintext,
      sequenceNumber: this.seq,
      createdAt: this.now(),
      keyEpoch: this.currentEpoch,
    });
    const json = envelopeToJson(envelope);
    const bytes = new TextEncoder().encode(JSON.stringify(json));

    if (await this.deliverBytes(recipientId, bytes)) return true;

    await this.cfg.db.outbox.add({
      bundleId: envelope.messageId,
      sourceDeviceId: this.me,
      destinationDeviceId: recipientId,
      workspaceId: this.cfg.workspaceId,
      encryptedPayload: bytes,
      createdAt: envelope.createdAt,
      expiresAt: envelope.createdAt + OUTBOX_TTL_MS,
      hopLimit,
      signature: envelope.signature,
      offeredTo: [],
    });
    return false;
  }

  /**
   * Try a direct peer-to-peer channel first (payload then bypasses the
   * relay entirely), then the relay. Returns false if neither is
   * currently available — caller queues for later.
   */
  private async deliverBytes(recipientId: string, bytes: Uint8Array): Promise<boolean> {
    if (this.cfg.direct) {
      try {
        if (this.cfg.direct.trySend(recipientId, bytes)) return true;
      } catch {
        // fall through to the relay
      }
    }
    if (this.cfg.transport.isConnected) {
      try {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as EnvelopeJson;
        this.cfg.transport.sendEnvelope(json);
        return true;
      } catch {
        // fall through — caller queues
      }
    }
    return false;
  }

  private async drainOutbox(): Promise<void> {
    await this.cfg.db.outbox.where("expiresAt").below(this.now()).delete();
    for (const bundle of await this.cfg.db.outbox.toArray()) {
      if (await this.deliverBytes(bundle.destinationDeviceId, bundle.encryptedPayload)) {
        await this.cfg.db.outbox.delete(bundle.bundleId);
      }
    }
  }

  /**
   * Store–carry–forward, part 1: for each bundle this device is CARRYING
   * on behalf of someone else, forward it the moment the true destination
   * looks reachable — same encrypted bytes, so the destination verifies
   * and decrypts exactly as if it arrived directly from the sender.
   */
  private async attemptCarriedDelivery(): Promise<void> {
    const now = this.now();
    await this.cfg.db.carried.where("expiresAt").below(now).delete();
    for (const bundle of await this.cfg.db.carried.toArray()) {
      const dest = await this.cfg.db.devices.get(bundle.destinationDeviceId);
      if (dest?.status !== "online") continue;
      if (await this.forwardCarriedBytes(bundle.destinationDeviceId, bundle.encryptedPayload)) {
        await this.cfg.db.carried.delete(bundle.bundleId);
      }
    }
  }

  /**
   * Like deliverBytes, but for envelopes we're carrying on someone else's
   * behalf: over the relay this MUST use forwardEnvelope (type "forward"),
   * not sendEnvelope — the relay rejects "envelope" messages whose inner
   * senderDeviceId doesn't match our own authenticated connection, which
   * is exactly true here (we're relaying, not sending our own). A direct
   * peer channel has no such restriction — it's just bytes to the peer.
   */
  private async forwardCarriedBytes(recipientId: string, bytes: Uint8Array): Promise<boolean> {
    if (this.cfg.direct) {
      try {
        if (this.cfg.direct.trySend(recipientId, bytes)) return true;
      } catch {
        // fall through to the relay
      }
    }
    if (this.cfg.transport.isConnected) {
      try {
        const json = JSON.parse(new TextDecoder().decode(bytes)) as EnvelopeJson;
        this.cfg.transport.forwardEnvelope(json);
        return true;
      } catch {
        // fall through — caller keeps the bundle queued
      }
    }
    return false;
  }

  /**
   * Store–carry–forward, part 2: for our own OUTBOX bundles stuck behind
   * an offline destination, hand a copy to one currently-online peer
   * (never the destination itself) as a carrier — bounded by hopLimit so
   * fan-out can't run away. We keep trying direct delivery ourselves too
   * (drainOutbox); carrying is purely supplemental redundancy for when we
   * go offline again before the destination ever reconnects to us.
   */
  private async offerCarrying(): Promise<void> {
    const outboxBundles = await this.cfg.db.outbox.toArray();
    if (outboxBundles.length === 0) return;
    const onlinePeers = (await this.cfg.db.devices.toArray()).filter(
      (d) => d.id !== this.me && d.status === "online",
    );
    if (onlinePeers.length === 0) return;

    for (const bundle of outboxBundles) {
      if (bundle.hopLimit <= 0) continue;
      const offeredTo = bundle.offeredTo ?? [];
      const carrier = onlinePeers.find(
        (d) => d.id !== bundle.destinationDeviceId && !offeredTo.includes(d.id),
      );
      if (!carrier) continue;

      const nextHopLimit = bundle.hopLimit - 1;
      const sent = await this.sendOps(carrier.id, [
        this.makeOp("CARRY_BUNDLE", undefined, {
          bundleId: bundle.bundleId,
          sourceDeviceId: bundle.sourceDeviceId,
          destinationDeviceId: bundle.destinationDeviceId,
          encryptedPayloadB64: toBase64(bundle.encryptedPayload),
          createdAt: bundle.createdAt,
          expiresAt: bundle.expiresAt,
          hopLimit: nextHopLimit,
        } satisfies CarryBundlePayload),
      ]);
      if (sent) {
        await this.cfg.db.outbox.update(bundle.bundleId, {
          hopLimit: nextHopLimit,
          offeredTo: [...offeredTo, carrier.id],
        });
      }
    }
  }

  /** Delete MeshObjects whose expiresAt has passed; mark their in-flight
   *  deliveries "expired" (kept, not deleted, so Sent/inbox history still
   *  shows the final status) rather than leaving them stuck as queued/sending. */
  private async sweepExpiredObjects(): Promise<void> {
    const now = this.now();
    for (const object of await this.cfg.db.objects.where("expiresAt").below(now).toArray()) {
      const deliveries = await this.cfg.db.deliveries.where("objectId").equals(object.id).toArray();
      for (const delivery of deliveries) {
        if (delivery.status !== "opened") {
          await this.cfg.db.deliveries.update(delivery.id, { status: "expired" });
        }
      }
      await this.purgeObject(object.id);
    }
  }

  /** Runs on a timer (and once at startup / on presence change) to advance
   *  expiry and store-carry-forward without needing a user action. */
  private async periodicSweep(): Promise<void> {
    try {
      await this.sweepExpiredObjects();
      await this.attemptCarriedDelivery();
      await this.offerCarrying();
    } catch (err) {
      console.error("screenmesh: periodic sweep failed", err);
    }
  }

  private async handleIncoming(data: Uint8Array): Promise<void> {
    const json = JSON.parse(new TextDecoder().decode(data)) as EnvelopeJson;
    const envelope = envelopeFromJson(json);
    const now = this.now();

    if (envelope.recipientDeviceId !== this.me) return;
    if (envelope.workspaceId !== this.cfg.workspaceId) return;
    if (await this.cfg.db.seen.get(envelope.messageId)) return;

    const workspaceKey = this.keys.get(envelope.keyEpoch);
    if (!workspaceKey) {
      throw new Error(
        `no workspace key for epoch ${envelope.keyEpoch} (envelope ${envelope.messageId})`,
      );
    }
    const senderKey = await this.keyFor(envelope.senderDeviceId);
    const plaintext = await openEnvelope(envelope, senderKey, workspaceKey, now);
    await this.cfg.db.seen.add({ messageId: envelope.messageId, seenAt: now });

    const { ops } = JSON.parse(new TextDecoder().decode(plaintext)) as {
      ops: Operation<unknown>[];
    };
    for (const op of ops) {
      await this.applyOp(envelope.senderDeviceId, op);
    }
  }

  private async applyOp(senderId: string, op: Operation<unknown>): Promise<void> {
    await this.cfg.db.operations.put(op);
    const now = this.now();

    switch (op.type) {
      case "CREATE_OBJECT": {
        const { object } = op.payload as CreateObjectPayload;
        const existing = await this.cfg.db.objects.get(object.id);
        if (!existing) await this.cfg.db.objects.put(object);
        break;
      }
      case "UPDATE_OBJECT": {
        const { objectId, content, updatedAt } = op.payload as UpdateObjectPayload;
        const object = await this.cfg.db.objects.get(objectId);
        if (object && updatedAt >= object.updatedAt) {
          await this.cfg.db.objects.update(objectId, { content, updatedAt });
        }
        break;
      }
      case "YJS_UPDATE": {
        const { objectId, updateB64 } = op.payload as YjsUpdatePayload;
        const doc = await this.docFor(objectId);
        Y.applyUpdate(doc, fromBase64(updateB64));
        await this.persistDoc(objectId, doc);
        const object = await this.cfg.db.objects.get(objectId);
        if (object && EDITABLE_TYPES.has(object.type)) {
          const merged = doc.getText("text").toString();
          const current = (object.content as TextContent | null)?.text ?? "";
          if (merged !== current) {
            await this.cfg.db.objects.update(objectId, {
              content: { text: merged },
              updatedAt: now,
            });
          }
        }
        break;
      }
      case "CONTINUE_ON_DEVICE": {
        const { objectId } = op.payload as ContinueOnDevicePayload;
        await this.cfg.db.settings.put({
          key: "focusObject",
          value: { objectId, from: senderId, at: now },
        });
        break;
      }
      case "SEND_TO_DEVICE": {
        const { objectId, options } = op.payload as SendToDevicePayload;
        const existing = await this.cfg.db.deliveries
          .where("objectId")
          .equals(objectId)
          .and(
            (d) =>
              d.destinationDeviceId === this.me && d.sourceDeviceId === senderId,
          )
          .first();
        // requireConfirmation gates the recipient behind an explicit
        // accept/reject — the sender only learns "delivered" once the
        // user acts (see acceptObject/rejectObject).
        const gated = !!options?.requireConfirmation;
        if (!existing) {
          await this.cfg.db.deliveries.add({
            id: crypto.randomUUID(),
            objectId,
            sourceDeviceId: senderId,
            destinationDeviceId: this.me,
            status: gated ? "pending" : "delivered",
            createdAt: now,
            ...(gated ? {} : { deliveredAt: now }),
            ...(options && Object.keys(options).length > 0 ? { options } : {}),
          });
        }
        if (!gated) {
          await this.sendOps(senderId, [
            this.makeOp("MARK_DELIVERED", objectId, {
              objectId,
            } satisfies ObjectRefPayload),
          ]);
        }
        break;
      }
      case "MARK_DELIVERED": {
        const { objectId } = op.payload as ObjectRefPayload;
        const delivery = await this.cfg.db.deliveries
          .where("objectId")
          .equals(objectId)
          .and(
            (d) => d.sourceDeviceId === this.me && d.destinationDeviceId === senderId,
          )
          .first();
        if (delivery && delivery.status !== "opened") {
          await this.cfg.db.deliveries.update(delivery.id, {
            status: "delivered",
            deliveredAt: now,
          });
        }
        break;
      }
      case "MARK_OPENED": {
        const { objectId } = op.payload as ObjectRefPayload;
        const delivery = await this.cfg.db.deliveries
          .where("objectId")
          .equals(objectId)
          .and(
            (d) => d.sourceDeviceId === this.me && d.destinationDeviceId === senderId,
          )
          .first();
        if (delivery) {
          await this.cfg.db.deliveries.update(delivery.id, {
            status: "opened",
            openedAt: now,
          });
        }
        break;
      }
      case "DELETE_OBJECT": {
        const { objectId } = op.payload as ObjectRefPayload;
        await this.cfg.db.objects.delete(objectId);
        break;
      }
      case "REJECT_OBJECT": {
        const { objectId } = op.payload as ObjectRefPayload;
        const delivery = await this.cfg.db.deliveries
          .where("objectId")
          .equals(objectId)
          .and(
            (d) => d.sourceDeviceId === this.me && d.destinationDeviceId === senderId,
          )
          .first();
        if (delivery) {
          await this.cfg.db.deliveries.update(delivery.id, { status: "rejected" });
        }
        break;
      }
      case "CARRY_BUNDLE": {
        const payload = op.payload as CarryBundlePayload;
        if (payload.destinationDeviceId === this.me) break; // nothing to carry to ourselves
        if (payload.expiresAt <= now) break;
        if (await this.cfg.db.carried.get(payload.bundleId)) break; // already holding it
        const bundle: DeliveryBundle = {
          bundleId: payload.bundleId,
          sourceDeviceId: payload.sourceDeviceId,
          destinationDeviceId: payload.destinationDeviceId,
          workspaceId: op.workspaceId,
          encryptedPayload: fromBase64(payload.encryptedPayloadB64),
          createdAt: payload.createdAt,
          expiresAt: payload.expiresAt,
          hopLimit: payload.hopLimit,
          // The carrier can't independently verify the inner envelope's
          // signature (it may not have that sender's key cached) — the
          // true destination re-verifies it on arrival regardless.
          signature: new Uint8Array(),
        };
        await this.cfg.db.carried.add(bundle);
        break;
      }
      case "REVOKE_DEVICE": {
        const { deviceId } = op.payload as RevokeDevicePayload;
        if (senderId !== this.cfg.ownerDeviceId) break;
        await this.cfg.db.devices.delete(deviceId);
        this.peerKeys.delete(deviceId);
        break;
      }
      case "ROTATE_KEY": {
        if (senderId !== this.cfg.ownerDeviceId) break;
        const { epoch, wrappedKeyB64, nonceB64 } = op.payload as RotateKeyPayload;
        if (this.keys.has(epoch)) break;
        const sender = await this.cfg.db.devices.get(senderId);
        if (!sender?.encryptionKey) {
          console.warn("screenmesh: ROTATE_KEY from a sender without an encryption key");
          break;
        }
        const senderPublic = await importEncryptionPublicKey(sender.encryptionKey);
        const rawKey = await unwrapKeyBytes(
          this.cfg.identity.encryptionPrivateKey,
          senderPublic,
          { wrappedKeyB64, nonceB64 },
        );
        await this.adoptKey(epoch, await importRawWorkspaceKey(rawKey));
        break;
      }
      default:
        break;
    }
  }

  private async applyPresence(entries: PresenceEntry[]): Promise<void> {
    const rows: Device[] = entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      publicKey: entry.publicKey,
      ...(entry.encryptionKey !== undefined
        ? { encryptionKey: entry.encryptionKey }
        : {}),
      type: entry.type,
      role: entry.type === "phone" ? "input" : "editor",
      lastSeenAt: entry.lastSeenAt,
      status: entry.online ? "online" : "offline",
      trusted: true,
    }));
    await this.cfg.db.devices.bulkPut(rows);
    // The roster is authoritative: devices no longer in it were revoked.
    const ids = new Set(entries.map((entry) => entry.id));
    await this.cfg.db.devices.filter((d) => !ids.has(d.id)).delete();

    // A device just went online — that's the moment carried bundles for
    // it can be forwarded, and a moment a new carrier becomes available.
    await this.attemptCarriedDelivery();
    await this.offerCarrying();
  }

  private async keyFor(deviceId: string): Promise<CryptoKey> {
    const cached = this.peerKeys.get(deviceId);
    if (cached) return cached;
    const device = await this.cfg.db.devices.get(deviceId);
    if (!device) throw new Error(`unknown sender device ${deviceId}`);
    const key = await importPublicKey(device.publicKey);
    this.peerKeys.set(deviceId, key);
    return key;
  }
}
