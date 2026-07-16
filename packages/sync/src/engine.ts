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
  type FileChunkPayload,
  type FileContent,
  type MeshObject,
  type MeshObjectType,
  type ObjectRefPayload,
  type Operation,
  type OperationType,
  type PresenceEntry,
  type RevokeDevicePayload,
  type SendOptions,
  type SendToDevicePayload,
  type TextContent,
  type UpdateObjectPayload,
  type YjsUpdatePayload,
} from "@screenmesh/protocol";
import {
  decryptEnvelope,
  exportRawWorkspaceKey,
  importEncryptionPublicKey,
  importPublicKey,
  initRatchetSession,
  ratchetDecrypt,
  ratchetEncrypt,
  sealEnvelope,
  verifyEnvelope,
  type DeviceIdentity,
  type RatchetSession,
} from "@screenmesh/crypto";
import type { PersistedRatchetSession, ScreenMeshDb } from "@screenmesh/storage";
import type { WebSocketRelayTransport } from "@screenmesh/transport";

const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often to sweep expired objects/bundles and advance store-carry-forward. */
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

/** Object types whose text is collaboratively editable via Yjs. */
const EDITABLE_TYPES = new Set(["text", "code", "link"]);

/**
 * Secure file drop: files whose base64 payload exceeds this many
 * characters (~150 KB raw) are split into chunks, each its own envelope
 * (own ratchet message, own carry-eligibility), rather than one giant
 * envelope. Keeps individual messages small regardless of file size.
 */
const FILE_CHUNK_SIZE_B64 = 200_000;
const FILE_CHUNK_THRESHOLD_B64 = FILE_CHUNK_SIZE_B64;

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
  /** Pairing secret from the QR — seeds every pairwise ratchet session
   *  (docs/Security.md §5), not used to encrypt anything directly. */
  workspaceKey: CryptoKey;
  /** Only this device may revoke devices. */
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
  /** In-memory Double Ratchet sessions, one per peer device. */
  private readonly ratchets = new Map<string, RatchetSession>();
  /** Raw bytes of the pairing secret, computed once in start(). */
  private pairingSecret!: Uint8Array;
  /** In-memory Yjs docs for collaboratively edited objects. */
  private readonly ydocs = new Map<string, Y.Doc>();
  /** In-progress file reassembly buffers, keyed by fileId (in-memory only —
   *  a reload mid-transfer loses partial progress and needs a re-send). */
  private readonly incomingChunks = new Map<
    string,
    { total: number; chunks: Map<number, string>; meta?: FileChunkPayload["meta"] }
  >();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: EngineConfig) {}

  private get me(): string {
    return this.cfg.identity.deviceId;
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }

  async start(): Promise<void> {
    const seqSetting = await this.cfg.db.settings.get("mySeq");
    this.seq = typeof seqSetting?.value === "number" ? seqSetting.value : 0;

    this.pairingSecret = await exportRawWorkspaceKey(this.cfg.workspaceKey);
    for (const row of await this.cfg.db.ratchets.toArray()) {
      const { peerDeviceId, ...session } = row;
      this.ratchets.set(peerDeviceId, session as unknown as RatchetSession);
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

    // Secure file drop: large files travel as a sequence of small chunk
    // envelopes instead of one giant one (see FILE_CHUNK_THRESHOLD_B64).
    const asFile =
      (object.type === "file" || object.type === "image") && (object.content as FileContent);
    const chunked = asFile && asFile.dataB64.length > FILE_CHUNK_THRESHOLD_B64;

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

      let sentLive: boolean;
      if (chunked && asFile) {
        sentLive = await this.sendFileChunks(object, asFile, recipientId, options);
      } else {
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
        sentLive = await this.sendOps(recipientId, ops, DEFAULT_HOP_LIMIT);
      }
      if (sentLive) {
        await this.cfg.db.deliveries.update(delivery.id, { status: "sending" });
      }
    }
    return object;
  }

  /** Send a large file as a sequence of small chunk envelopes; each chunk
   *  is its own carry-eligible envelope. Returns true only if every chunk
   *  went out live (matching sendOps' live/queued return contract). */
  private async sendFileChunks(
    object: MeshObject,
    file: FileContent,
    recipientId: string,
    options: SendOptions,
  ): Promise<boolean> {
    const totalChunks = Math.ceil(file.dataB64.length / FILE_CHUNK_SIZE_B64);
    let allLive = true;
    for (let i = 0; i < totalChunks; i++) {
      const dataB64 = file.dataB64.slice(i * FILE_CHUNK_SIZE_B64, (i + 1) * FILE_CHUNK_SIZE_B64);
      const payload: FileChunkPayload = {
        fileId: object.id,
        chunkIndex: i,
        totalChunks,
        dataB64,
        ...(i === 0
          ? {
              meta: {
                objectType: object.type as "file" | "image",
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
                createdBy: object.createdBy,
                createdAt: object.createdAt,
                ...(object.expiresAt !== undefined ? { expiresAt: object.expiresAt } : {}),
                ...(Object.keys(options).length > 0 ? { options } : {}),
              },
            }
          : {}),
      };
      const sentLive = await this.sendOps(
        recipientId,
        [this.makeOp("FILE_CHUNK", object.id, payload)],
        DEFAULT_HOP_LIMIT,
      );
      if (!sentLive) allLive = false;
    }
    return allLive;
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
   * Capability routing (docs/Roadmap.md Phase 5): "send this to whichever
   * device has a terminal" instead of naming a specific device. Online
   * devices advertising the capability come first (an immediate, direct
   * send); offline ones are included after (queued/carried like any other
   * delivery) so the request isn't silently dropped if nobody's online
   * right now — the caller decides whether to include those.
   */
  async resolveCapability(capability: string): Promise<Device[]> {
    const matches = (await this.cfg.db.devices.toArray()).filter(
      (d) => d.id !== this.me && d.capabilities?.includes(capability),
    );
    return matches.sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === "online" ? -1 : 1;
    });
  }

  /**
   * Owner-side revocation: tell the remaining devices and drop the device
   * locally. Relay enforcement (rejecting the revoked device) happens via
   * the HTTP revoke endpoint — see docs/Security.md §2. Unlike the old
   * shared-workspace-key model, no group-wide rekey is needed: ratchet
   * sessions are pairwise, so dropping this one session doesn't touch
   * anyone else's secrecy (docs/Security.md §5).
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
    this.ratchets.delete(deviceId);
    await this.cfg.db.ratchets.delete(deviceId);
  }

  // --- internals ---

  /**
   * Get-or-create the Double Ratchet session with a peer (docs/Security.md
   * §5). Bootstraps from the peer's X25519 identity key (learned via
   * presence) and the workspace pairing secret; every pair in the
   * workspace gets its own independent session, so revoking one device
   * never requires touching anyone else's secrecy.
   */
  private async ratchetSessionFor(peerDeviceId: string): Promise<RatchetSession> {
    const cached = this.ratchets.get(peerDeviceId);
    if (cached) return cached;

    const stored = await this.cfg.db.ratchets.get(peerDeviceId);
    if (stored) {
      const { peerDeviceId: _discard, ...session } = stored;
      const restored = session as unknown as RatchetSession;
      this.ratchets.set(peerDeviceId, restored);
      return restored;
    }

    const peer = await this.cfg.db.devices.get(peerDeviceId);
    if (!peer?.encryptionKey) {
      throw new Error(
        `cannot start a ratchet session with ${peerDeviceId}: no encryption key on file`,
      );
    }
    const session = await initRatchetSession({
      workspaceId: this.cfg.workspaceId,
      myDeviceId: this.me,
      myIdentityPublic: this.cfg.identity.encryptionPublicKey,
      myIdentityPrivate: this.cfg.identity.encryptionPrivateKey,
      peerDeviceId,
      peerIdentityPublic: await importEncryptionPublicKey(peer.encryptionKey),
      pairingSecret: this.pairingSecret,
    });
    this.ratchets.set(peerDeviceId, session);
    await this.persistRatchetSession(peerDeviceId, session);
    return session;
  }

  private async persistRatchetSession(
    peerDeviceId: string,
    session: RatchetSession,
  ): Promise<void> {
    await this.cfg.db.ratchets.put({
      peerDeviceId,
      ...session,
    } as unknown as PersistedRatchetSession);
  }

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

    const session = await this.ratchetSessionFor(recipientId);
    const { messageKey, header } = await ratchetEncrypt(session);
    await this.persistRatchetSession(recipientId, session);

    const plaintext = new TextEncoder().encode(JSON.stringify({ ops }));
    const envelope = await sealEnvelope({
      identity: this.cfg.identity,
      recipientDeviceId: recipientId,
      workspaceId: this.cfg.workspaceId,
      messageKey,
      ratchetHeader: header,
      plaintext,
      sequenceNumber: this.seq,
      createdAt: this.now(),
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

  /**
   * Runs on a timer (and once at startup / on presence change) to advance
   * expiry and store-carry-forward without needing a user action. Guarded
   * against re-entrancy: the timer and presence updates can both trigger
   * this close together, and running attemptCarriedDelivery/offerCarrying
   * concurrently with itself would let both invocations read the
   * carried/outbox tables before either deletes its entry — forwarding
   * (or offering) the same bundle twice.
   */
  private sweeping = false;
  private async periodicSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepExpiredObjects();
      await this.attemptCarriedDelivery();
      await this.offerCarrying();
    } catch (err) {
      console.error("screenmesh: periodic sweep failed", err);
    } finally {
      this.sweeping = false;
    }
  }

  private async handleIncoming(data: Uint8Array): Promise<void> {
    const json = JSON.parse(new TextDecoder().decode(data)) as EnvelopeJson;
    const envelope = envelopeFromJson(json);
    const now = this.now();

    if (envelope.recipientDeviceId !== this.me) return;
    if (envelope.workspaceId !== this.cfg.workspaceId) return;
    if (await this.cfg.db.seen.get(envelope.messageId)) return;

    // Authenticity MUST be checked before the ratchet header is trusted
    // for anything — deriving a message key mutates session state, and a
    // forged header (before verification) must never be allowed to do
    // that. See packages/crypto/src/envelope.ts's module doc comment.
    const senderKey = await this.keyFor(envelope.senderDeviceId);
    await verifyEnvelope(envelope, senderKey, now);

    const session = await this.ratchetSessionFor(envelope.senderDeviceId);
    const messageKey = await ratchetDecrypt(session, {
      ratchetPublicKeyB64: envelope.ratchetPublicKeyB64,
      messageNumber: envelope.messageNumber,
      previousChainLength: envelope.previousChainLength,
    });
    await this.persistRatchetSession(envelope.senderDeviceId, session);
    const plaintext = await decryptEnvelope(envelope, messageKey);
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
        await this.recordIncomingDelivery(senderId, objectId, options, now);
        break;
      }
      case "FILE_CHUNK": {
        const payload = op.payload as FileChunkPayload;
        let entry = this.incomingChunks.get(payload.fileId);
        if (!entry) {
          entry = { total: payload.totalChunks, chunks: new Map() };
          this.incomingChunks.set(payload.fileId, entry);
        }
        entry.chunks.set(payload.chunkIndex, payload.dataB64);
        if (payload.meta) entry.meta = payload.meta;

        if (entry.chunks.size === entry.total && entry.meta) {
          const meta = entry.meta;
          let dataB64 = "";
          for (let i = 0; i < entry.total; i++) dataB64 += entry.chunks.get(i) ?? "";
          const object: MeshObject = {
            id: payload.fileId,
            workspaceId: op.workspaceId,
            type: meta.objectType,
            content: {
              name: meta.name,
              mimeType: meta.mimeType,
              size: meta.size,
              dataB64,
            } satisfies FileContent,
            createdBy: meta.createdBy,
            createdAt: meta.createdAt,
            updatedAt: meta.createdAt,
            ...(meta.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
          };
          const existingObject = await this.cfg.db.objects.get(object.id);
          if (!existingObject) await this.cfg.db.objects.put(object);
          this.incomingChunks.delete(payload.fileId);
          await this.recordIncomingDelivery(senderId, object.id, meta.options, now);
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
        this.ratchets.delete(deviceId);
        await this.cfg.db.ratchets.delete(deviceId);
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
      ...(entry.capabilities !== undefined ? { capabilities: entry.capabilities } : {}),
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
    // Routed through periodicSweep's reentrancy guard so this can't race
    // the timer-driven sweep (see periodicSweep's doc comment).
    void this.periodicSweep();
  }

  /**
   * Recipient-side bookkeeping shared by SEND_TO_DEVICE (normal objects)
   * and completed FILE_CHUNK reassembly: record the delivery (gated
   * "pending" if the sender required confirmation) and ack the sender.
   */
  private async recordIncomingDelivery(
    senderId: string,
    objectId: string,
    options: SendOptions | undefined,
    now: number,
  ): Promise<void> {
    const existing = await this.cfg.db.deliveries
      .where("objectId")
      .equals(objectId)
      .and((d) => d.destinationDeviceId === this.me && d.sourceDeviceId === senderId)
      .first();
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
        this.makeOp("MARK_DELIVERED", objectId, { objectId } satisfies ObjectRefPayload),
      ]);
    }
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
