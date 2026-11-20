// Protocole téléphone <-> IHM : messages JSON découpés en trames BLE.
// Miroir exact de picking_hmi/phone/protocol.py (tests croisés côté Python).
//
// Trame (≤ 20 octets = MTU ATT minimal − 3) :
//   octet 0     identifiant du message (0-255)
//   octets 1-2  index de la trame (big-endian)
//   octet 3     drapeaux : bit 0 = dernière trame
//   octets 4…   tranche du JSON UTF-8

export const PROTOCOL_VERSION = 1;
export const SERVICE_UUID = "a5c11000-7b1e-4c1f-9e2a-0d3c5f1a0000";
export const RX_UUID = "a5c11001-7b1e-4c1f-9e2a-0d3c5f1a0000"; // téléphone -> IHM (écriture)
export const TX_UUID = "a5c11002-7b1e-4c1f-9e2a-0d3c5f1a0000"; // IHM -> téléphone (notification)

export const HEADER_SIZE = 4;
export const DEFAULT_MAX_FRAME = 20;
export const FLAG_LAST = 0x01;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export class ProtocolError extends Error {}

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

export function encodeFrames(message, msgId, maxFrame = DEFAULT_MAX_FRAME) {
  if (maxFrame <= HEADER_SIZE) throw new RangeError("maxFrame doit dépasser l'en-tête");
  const payload = utf8.encode(JSON.stringify(message));
  if (payload.length > MAX_MESSAGE_BYTES) throw new RangeError(`message de ${payload.length} octets`);
  const chunk = maxFrame - HEADER_SIZE;
  const count = Math.max(1, Math.ceil(payload.length / chunk));
  const frames = [];
  for (let index = 0; index < count; index++) {
    const part = payload.subarray(index * chunk, (index + 1) * chunk);
    const frame = new Uint8Array(HEADER_SIZE + part.length);
    frame[0] = msgId & 0xff;
    frame[1] = (index >> 8) & 0xff;
    frame[2] = index & 0xff;
    frame[3] = index === count - 1 ? FLAG_LAST : 0;
    frame.set(part, HEADER_SIZE);
    frames.push(frame);
  }
  return frames;
}

export class MessageEncoder {
  constructor(maxFrame = DEFAULT_MAX_FRAME) {
    this.maxFrame = maxFrame;
    this.nextId = 0;
  }
  encode(message) {
    const frames = encodeFrames(message, this.nextId, this.maxFrame);
    this.nextId = (this.nextId + 1) & 0xff;
    return frames;
  }
}

export class FrameAssembler {
  constructor() {
    this.partial = null;
    this.discarded = 0;
  }
  reset() {
    this.partial = null;
  }
  /** Retourne le message complet à la dernière trame, null sinon ; ProtocolError si invalide. */
  feed(frame) {
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (bytes.length < HEADER_SIZE) throw new ProtocolError(`trame de ${bytes.length} octet(s)`);
    const msgId = bytes[0];
    const index = (bytes[1] << 8) | bytes[2];
    const flags = bytes[3];
    let partial = this.partial;
    if (index === 0) {
      if (partial) this.discarded += 1;
      partial = this.partial = { msgId, nextIndex: 0, chunks: [], size: 0 };
    } else if (!partial) {
      throw new ProtocolError(`trame ${index} du message ${msgId} sans son début`);
    } else if (msgId === partial.msgId && index === partial.nextIndex - 1) {
      return null; // trame répétée
    } else if (msgId !== partial.msgId || index !== partial.nextIndex) {
      this.partial = null;
      throw new ProtocolError(`trame ${msgId}/${index} reçue, ${partial.msgId}/${partial.nextIndex} attendue`);
    }
    const body = bytes.slice(HEADER_SIZE);
    partial.chunks.push(body);
    partial.size += body.length;
    partial.nextIndex = index + 1;
    if (partial.size > MAX_MESSAGE_BYTES) {
      this.partial = null;
      throw new ProtocolError("message trop long");
    }
    if (!(flags & FLAG_LAST)) return null;
    this.partial = null;
    const data = new Uint8Array(partial.size);
    let offset = 0;
    for (const chunk of partial.chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    let message;
    try {
      message = JSON.parse(utf8Strict.decode(data));
    } catch (error) {
      throw new ProtocolError(`message ${msgId} illisible (${error.message})`);
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
      throw new ProtocolError(`message ${msgId} sans champ « type »`);
    }
    return message;
  }
}
