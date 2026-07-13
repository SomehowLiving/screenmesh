import {
  envelopeFromJson,
  envelopeToJson,
  type CreateObjectPayload,
  type Delivery,
  type Device,
  type EnvelopeJson,
  type MeshObject,
  type MeshObjectType,
  type ObjectRefPayload,
  type Operation,
  type OperationType,
  type PresenceEntry,
  type SendOptions,
  type SendToDevicePayload,
} from "@screenmesh/protocol";
import {
  importPublicKey,
  openEnvelope,
  sealEnvelope,
  type DeviceIdentity,
} from "@screenmesh/crypto";
import type { ScreenMeshDb } from "@screenmesh/storage";
import type { WebSocketRelayTransport } from "@screenmesh/transport";

const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface EngineConfig {
  db: ScreenMeshDb;
  identity: DeviceIdentity;
  workspaceId: string;
  workspaceKey: CryptoKey;
  transport: WebSocketRelayTransport;
  now?: () => number;
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
    await this.cfg.db.seen
      .where("seenAt")
      .below(this.now() - SEEN_RETENTION_MS)
      .delete();

    const transport = this.cfg.transport;
    transport.onMessage((data) => {
      void this.handleIncoming(data).catch((err) => {
        console.error("screenmesh: failed to process incoming envelope", err);
      });
    });
    transport.subscribePresence((devices) => {
      void this.applyPresence(devices);
    });
    transport.subscribeStatus((status) => {
      if (status === "connected") void this.drainOutbox();
    });
    await transport.open();
  }

  async stop(): Promise<void> {
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

    for (const recipientId of recipientIds) {
      const delivery: Delivery = {
        id: crypto.randomUUID(),
        objectId: object.id,
        sourceDeviceId: this.me,
        destinationDeviceId: recipientId,
        status: "queued",
        createdAt: now,
      };
      await this.cfg.db.deliveries.add(delivery);
      const ops = [
        this.makeOp("CREATE_OBJECT", object.id, {
          object,
        } satisfies CreateObjectPayload),
        this.makeOp("SEND_TO_DEVICE", object.id, {
          objectId: object.id,
          options,
        } satisfies SendToDevicePayload),
      ];
      const sentLive = await this.sendOps(recipientId, ops);
      if (sentLive) {
        await this.cfg.db.deliveries.update(delivery.id, { status: "sending" });
      }
    }
    return object;
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
    if (!delivery || delivery.status === "opened") return;
    await this.cfg.db.deliveries.update(delivery.id, {
      status: "opened",
      openedAt: this.now(),
    });
    await this.sendOps(object.createdBy, [
      this.makeOp("MARK_OPENED", objectId, { objectId } satisfies ObjectRefPayload),
    ]);
  }

  /** Local-only delete (MVP): removes the object and its delivery rows. */
  async deleteObjectLocal(objectId: string): Promise<void> {
    await this.cfg.db.objects.delete(objectId);
    await this.cfg.db.deliveries.where("objectId").equals(objectId).delete();
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

  /** Seal ops into an envelope; send live or queue in the outbox. */
  private async sendOps(
    recipientId: string,
    ops: Operation<unknown>[],
  ): Promise<boolean> {
    this.seq += 1;
    await this.cfg.db.settings.put({ key: "mySeq", value: this.seq });

    const plaintext = new TextEncoder().encode(JSON.stringify({ ops }));
    const envelope = await sealEnvelope({
      identity: this.cfg.identity,
      recipientDeviceId: recipientId,
      workspaceId: this.cfg.workspaceId,
      workspaceKey: this.cfg.workspaceKey,
      plaintext,
      sequenceNumber: this.seq,
      createdAt: this.now(),
    });
    const json = envelopeToJson(envelope);

    if (this.cfg.transport.isConnected) {
      try {
        this.cfg.transport.sendEnvelope(json);
        return true;
      } catch {
        // fall through to the outbox
      }
    }
    await this.cfg.db.outbox.add({
      bundleId: envelope.messageId,
      sourceDeviceId: this.me,
      destinationDeviceId: recipientId,
      workspaceId: this.cfg.workspaceId,
      encryptedPayload: new TextEncoder().encode(JSON.stringify(json)),
      createdAt: envelope.createdAt,
      expiresAt: envelope.createdAt + OUTBOX_TTL_MS,
      hopLimit: 1,
      signature: envelope.signature,
    });
    return false;
  }

  private async drainOutbox(): Promise<void> {
    await this.cfg.db.outbox.where("expiresAt").below(this.now()).delete();
    const bundles = await this.cfg.db.outbox.toArray();
    for (const bundle of bundles) {
      try {
        await this.cfg.transport.send(bundle.encryptedPayload);
        await this.cfg.db.outbox.delete(bundle.bundleId);
      } catch {
        return; // transport dropped again; keep the rest queued
      }
    }
  }

  private async handleIncoming(data: Uint8Array): Promise<void> {
    const json = JSON.parse(new TextDecoder().decode(data)) as EnvelopeJson;
    const envelope = envelopeFromJson(json);
    const now = this.now();

    if (envelope.recipientDeviceId !== this.me) return;
    if (envelope.workspaceId !== this.cfg.workspaceId) return;
    if (await this.cfg.db.seen.get(envelope.messageId)) return;

    const senderKey = await this.keyFor(envelope.senderDeviceId);
    const plaintext = await openEnvelope(
      envelope,
      senderKey,
      this.cfg.workspaceKey,
      now,
    );
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
        await this.cfg.db.objects.put(object);
        break;
      }
      case "SEND_TO_DEVICE": {
        const { objectId } = op.payload as SendToDevicePayload;
        const existing = await this.cfg.db.deliveries
          .where("objectId")
          .equals(objectId)
          .and(
            (d) =>
              d.destinationDeviceId === this.me && d.sourceDeviceId === senderId,
          )
          .first();
        if (!existing) {
          await this.cfg.db.deliveries.add({
            id: crypto.randomUUID(),
            objectId,
            sourceDeviceId: senderId,
            destinationDeviceId: this.me,
            status: "delivered",
            createdAt: now,
            deliveredAt: now,
          });
        }
        await this.sendOps(senderId, [
          this.makeOp("MARK_DELIVERED", objectId, {
            objectId,
          } satisfies ObjectRefPayload),
        ]);
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
      default:
        break;
    }
  }

  private async applyPresence(entries: PresenceEntry[]): Promise<void> {
    const rows: Device[] = entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      publicKey: entry.publicKey,
      type: entry.type,
      role: entry.type === "phone" ? "input" : "editor",
      lastSeenAt: entry.lastSeenAt,
      status: entry.online ? "online" : "offline",
      trusted: true,
    }));
    await this.cfg.db.devices.bulkPut(rows);
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
