/**
 * Reading zstd (RFC 8878) with no dependency: Codex compresses a rollout it has not written to for a week into
 * rollout-….jsonl.zst (lib/session.mjs), and node:zlib unpacks zstd only from Node 22.15 and 23.8 on. A decoder of the
 * frames libzstd writes: raw, RLE and compressed blocks, Huffman-coded literals, FSE-coded sequences, skippable frames.
 * A frame that needs a dictionary is turned down; the content checksum is not checked, the content size is when the
 * frame says it.
 *
 *   zstdChunks(bytes)          the unpacked bytes, a block at a time: a rollout runs to hundreds of megabytes
 *   zstdChunks(bytes, true)    the same of the start of a file: stops quietly where $bytes end in the middle of a block
 *   zstdContentSize(bytes)     the unpacked size the first frame's header says, or null
 */

const MAGIC = 0xfd2fb528;
const MAX_BLOCK = 128 * 1024;
/** What libzstd unpacks without being told it may use more (ZSTD_WINDOWLOG_LIMIT_DEFAULT): 128 MB. */
const MAX_WINDOW = 2 ** 27;

/** The literals length codes (RFC 8878, 3.1.1.3.2.1.1): a baseline and the number of bits added to it. */
const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
/** The match length codes. */
const ML_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
    35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539,
];
const ML_BITS = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
/** The predefined distributions of the three codes (3.1.1.3.2.2), with their accuracy logs. */
const LL_DEFAULT = [[4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6];
const ML_DEFAULT = [[1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1], 6];
const OF_DEFAULT = [[1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5];
const defaults = new Map();

class ZstdError extends Error {}
const fail = (why) => {
    throw new ZstdError(`Not zstd this can unpack: ${why}.`);
};
const highBit = (n) => 31 - Math.clz32(n);

/**
 * The unpacked bytes of $bytes (one frame after another), a Buffer per block. $partial: $bytes are the start of a
 * file, and a block they cut off ends the reading, without an error.
 */
export function* zstdChunks(bytes, partial = false) {
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let at = 0;
    while (at < src.length) {
        if (src.length - at < 8) {
            if (partial) return;
            fail('the data ends inside a frame header');
        }
        const magic = u32(src, at);
        // A skippable frame: four bytes of its size, then as many to skip.
        if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
            at += 8 + u32(src, at + 4);
            continue;
        }
        if (magic !== MAGIC) fail('no zstd frame');
        const header = frameHeader(src, at);
        if (header === null) {
            if (partial) return;
            fail('the data ends inside a frame header');
        }
        at = yield* frame(src, header, partial);
        if (at === null) return;
    }
}

/**
 * The unpacked size the header of the first frame of $bytes says (18 bytes at most), or null when it does not say: the
 * whole size of a file of one frame, as Codex writes them.
 */
export function zstdContentSize(bytes) {
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const header = src.length >= 8 && u32(src, 0) === MAGIC ? frameHeader(src, 0) : null;

    return header?.contentSize ?? null;
}

const u32 = (src, at) => (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;

/** A frame's header at $at (3.1.1.1), or null when $src ends inside it. */
function frameHeader(src, at) {
    const descriptor = src[at + 4];
    const sizeBytes = [0, 2, 4, 8][descriptor >> 6];
    const single = (descriptor & 0x20) !== 0;
    if (descriptor & 0x08) fail('a reserved bit is set');
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
    let p = at + 5;
    let window = 0;
    if (!single) {
        const w = src[p++];
        const log = 10 + (w >> 3);
        window = 2 ** log + (2 ** log / 8) * (w & 7);
    }
    let dictionary = 0;
    for (let i = 0; i < dictionaryBytes; i++) dictionary += src[p + i] * 2 ** (8 * i);
    p += dictionaryBytes;
    const fieldBytes = sizeBytes || (single ? 1 : 0);
    if (p + fieldBytes > src.length) return null;
    let contentSize = null;
    if (fieldBytes) {
        contentSize = 0;
        for (let i = 0; i < fieldBytes; i++) contentSize += src[p + i] * 2 ** (8 * i);
        if (fieldBytes === 2) contentSize += 256;
    }
    p += fieldBytes;
    if (dictionary) fail('the frame needs a dictionary');
    if (single) window = contentSize;

    return { start: p, window, contentSize, checksum: (descriptor & 0x04) !== 0 };
}

/**
 * Unpacks the frame whose blocks start at $header.start, yielding a Buffer per block; returns where the next frame
 * starts, or null when $partial reading stopped at a block cut off.
 */
function* frame(src, header, partial) {
    if (header.window > MAX_WINDOW) fail(`its window is ${header.window} bytes`);
    // What a match may reach back to stays in the buffer: the window. A block's own output fits in after it (limit).
    const keep = header.window;
    const out = { buf: new Uint8Array(Math.min(keep, 1024 * 1024) + 2 * MAX_BLOCK), pos: 0, keep, limit: 0 };
    const state = { rep: [1, 4, 8], huffman: null, ll: null, of: null, ml: null };
    let total = 0;
    let at = header.start;
    for (let last = false; !last; ) {
        if (at + 3 > src.length) {
            if (partial) return null;
            fail('the data ends inside a block header');
        }
        const h = src[at] | (src[at + 1] << 8) | (src[at + 2] << 16);
        last = (h & 1) === 1;
        const type = (h >> 1) & 3;
        const size = h >>> 3;
        at += 3;
        if (type === 3) fail('a block of a reserved type');
        const end = at + (type === 1 ? 1 : size);
        if (end > src.length) {
            if (partial) return null;
            fail('the data ends inside a block');
        }
        if (size > MAX_BLOCK) fail('a block is too large');
        room(out, MAX_BLOCK);
        const from = out.pos;
        out.limit = from + MAX_BLOCK;
        if (type === 0) {
            out.buf.set(src.subarray(at, end), out.pos);
            out.pos += size;
        } else if (type === 1) {
            out.buf.fill(src[at], out.pos, out.pos + size);
            out.pos += size;
        } else {
            block(src, at, end, state, out);
        }
        at = end;
        total += out.pos - from;
        if (out.pos > from) yield Buffer.from(out.buf.subarray(from, out.pos));
    }
    if (header.contentSize !== null && total !== header.contentSize) fail(`the frame says ${header.contentSize} bytes and holds ${total}`);
    if (header.checksum) {
        if (at + 4 > src.length) {
            if (partial) return null;
            fail('the data ends inside a checksum');
        }
        at += 4;
    }

    return at;
}

/** Makes room in the buffer for a block of $bytes more, before it is unpacked: what is older than the window goes. */
function room(out, bytes) {
    if (out.pos + bytes <= out.buf.length) return;
    const keep = Math.min(out.keep, out.pos);
    if (keep + bytes <= out.buf.length && out.pos - keep >= out.buf.length / 4) {
        out.buf.copyWithin(0, out.pos - keep, out.pos);
        out.pos = keep;
        return;
    }
    const bigger = new Uint8Array(Math.max(out.buf.length * 2, out.pos + bytes));
    bigger.set(out.buf.subarray(0, out.pos));
    out.buf = bigger;
}

/** A compressed block (3.1.1.3): its literals, then the sequences that put them and the matches together. */
function block(src, at, end, state, out) {
    const { literals, size } = readLiterals(src, at, state);
    at += size;
    if (at > end) fail('the literals run past the block');
    let count = src[at++];
    if (count >= 128) {
        if (count < 255) count = ((count - 128) << 8) + src[at++];
        else {
            count = src[at] + (src[at + 1] << 8) + 0x7f00;
            at += 2;
        }
    }
    if (count === 0) {
        if (at > end) fail('the sequences run past the block');
        copyOut(out, literals, 0, literals.length);
        return;
    }
    const modes = src[at++];
    for (const [key, mode, kind] of [['ll', modes >> 6, LL_DEFAULT], ['of', (modes >> 4) & 3, OF_DEFAULT], ['ml', (modes >> 2) & 3, ML_DEFAULT]]) {
        if (mode === 0) state[key] = defaultTable(kind);
        else if (mode === 1) state[key] = rleTable(src[at++]);
        else if (mode === 2) {
            const read = readFseTable(src, at, key === 'of' ? 8 : 9);
            state[key] = read.table;
            at += read.size;
        } else if (!state[key]) fail('sequences repeat a table there is none of');
    }
    if (at >= end) fail('the sequences run past the block');
    sequences(src.subarray(at, end), count, literals, state, out);
}

/** The literals section at $at (3.1.1.3.1): {literals, size}, size being the section's length in the block. */
function readLiterals(src, at, state) {
    const b0 = src[at];
    const type = b0 & 3;
    const format = (b0 >> 2) & 3;
    if (type < 2) {
        let size;
        let header;
        if ((format & 1) === 0) {
            size = b0 >> 3;
            header = 1;
        } else if (format === 1) {
            size = (b0 >> 4) + (src[at + 1] << 4);
            header = 2;
        } else {
            size = (b0 >> 4) + (src[at + 1] << 4) + (src[at + 2] << 12);
            header = 3;
        }
        if (size > MAX_BLOCK) fail('too many literals');
        if (type === 0) return { literals: src.subarray(at + header, at + header + size), size: header + size };

        return { literals: new Uint8Array(size).fill(src[at + header]), size: header + 1 };
    }

    const b1 = src[at + 1];
    const b2 = src[at + 2];
    let header;
    let regenerated;
    let compressed;
    if (format < 2) {
        header = 3;
        regenerated = (b0 >> 4) | ((b1 & 0x3f) << 4);
        compressed = (b1 >> 6) | (b2 << 2);
    } else if (format === 2) {
        header = 4;
        regenerated = (b0 >> 4) | (b1 << 4) | ((b2 & 3) << 12);
        compressed = (b2 >> 2) | (src[at + 3] << 6);
    } else {
        header = 5;
        regenerated = (b0 >> 4) | (b1 << 4) | ((b2 & 0x3f) << 12);
        compressed = (b2 >> 6) | (src[at + 3] << 2) | (src[at + 4] << 10);
    }
    if (regenerated > MAX_BLOCK) fail('too many literals');
    let from = at + header;
    const end = from + compressed;
    if (type === 2) {
        const read = readHuffmanTable(src, from, end);
        state.huffman = read.table;
        from += read.size;
    } else if (!state.huffman) fail('literals repeat a Huffman table there is none of');
    const literals = new Uint8Array(regenerated);
    if (format === 0) {
        huffmanStream(state.huffman, src.subarray(from, end), literals, 0, regenerated);
    } else {
        // Four streams, after a jump table of the sizes of the first three.
        const sizes = [src[from] | (src[from + 1] << 8), src[from + 2] | (src[from + 3] << 8), src[from + 4] | (src[from + 5] << 8)];
        from += 6;
        sizes.push(end - from - sizes[0] - sizes[1] - sizes[2]);
        if (sizes[3] < 1) fail('a Huffman stream of no size');
        const segment = Math.floor((regenerated + 3) / 4);
        for (let k = 0; k < 4; k++) {
            huffmanStream(state.huffman, src.subarray(from, from + sizes[k]), literals, k * segment, k < 3 ? segment : regenerated - 3 * segment);
            from += sizes[k];
        }
    }

    return { literals, size: end - at };
}

/** A Huffman table from its description at $from (4.2.1): {table, size}. */
function readHuffmanTable(src, from, end) {
    const header = src[from];
    let weights;
    let size;
    if (header >= 128) {
        // Four bits a weight, the first in a byte's high half.
        const count = header - 127;
        size = 1 + Math.ceil(count / 2);
        weights = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            const b = src[from + 1 + (i >> 1)];
            weights[i] = i % 2 === 0 ? b >> 4 : b & 15;
        }
    } else {
        if (header === 0) fail('a Huffman description of no size');
        size = 1 + header;
        weights = fseWeights(src.subarray(from + 1, from + 1 + header));
    }
    if (from + size > end) fail('the Huffman description runs past the literals');

    return { table: huffmanTable(weights), size };
}

/** Huffman weights coded with FSE (4.2.1.2): two states on one table take turns, until the stream runs out. */
function fseWeights(src) {
    const { table, size } = readFseTable(src, 0, 7);
    const stream = backward(src.subarray(size));
    const weights = [];
    let s1 = stream.read(table.log);
    let s2 = stream.read(table.log);
    for (;;) {
        if (weights.length > 254) fail('too many Huffman weights');
        weights.push(table.symbol[s1]);
        s1 = table.base[s1] + stream.read(table.bits[s1]);
        if (stream.at < 0) {
            weights.push(table.symbol[s2]);
            break;
        }
        weights.push(table.symbol[s2]);
        s2 = table.base[s2] + stream.read(table.bits[s2]);
        if (stream.at < 0) {
            weights.push(table.symbol[s1]);
            break;
        }
    }

    return Uint8Array.from(weights);
}

/**
 * The decoding table of the weights (4.2.1.3): the last symbol's weight is what makes them add up to a power of 2.
 * Codes go by weight, then by symbol; a state of maxBits bits is looked up whole.
 */
function huffmanTable(weights) {
    let sum = 0;
    for (const w of weights) {
        if (w > 12) fail('a Huffman weight too large');
        if (w) sum += 1 << (w - 1);
    }
    if (sum === 0) fail('Huffman weights of no symbol');
    const maxBits = highBit(sum) + 1;
    const left = (1 << maxBits) - sum;
    if (maxBits > 12 || left & (left - 1)) fail('Huffman weights that do not add up');
    const lengths = new Uint8Array(weights.length + 1);
    weights.forEach((w, s) => (lengths[s] = w ? maxBits + 1 - w : 0));
    lengths[weights.length] = maxBits - highBit(left);

    const size = 1 << maxBits;
    const symbol = new Uint8Array(size);
    const length = new Uint8Array(size);
    const rankCount = new Uint32Array(maxBits + 1);
    for (const l of lengths) rankCount[l]++;
    const next = new Uint32Array(maxBits + 1);
    for (let l = maxBits; l >= 1; l--) {
        next[l - 1] = next[l] + rankCount[l] * (1 << (maxBits - l));
        length.fill(l, next[l], next[l - 1]);
    }
    if (next[0] !== size) fail('Huffman weights that do not add up');
    lengths.forEach((l, s) => {
        if (!l) return;
        const span = 1 << (maxBits - l);
        symbol.fill(s, next[l], next[l] + span);
        next[l] += span;
    });

    return { maxBits, symbol, length };
}

/**
 * $count literals from one Huffman stream, read backward from its end, into $out from $from: the next maxBits bits
 * name a symbol, which takes as many of them as its code is long. Most of the time goes here, hence the bits read by
 * hand, from a copy with zeros after it.
 */
function huffmanStream(table, stream, out, from, count) {
    const { maxBits, symbol, length } = table;
    const mask = (1 << maxBits) - 1;
    const last = stream[stream.length - 1];
    if (!last) fail('a bit stream with no end mark');
    const src = new Uint8Array(stream.length + 4);
    src.set(stream);
    let pos = stream.length * 8 - 8 + highBit(last);
    for (let i = from, end = from + count; i < end; i++) {
        const at = pos - maxBits;
        let bits;
        if (at >= 0) {
            const b = at >>> 3;
            bits = ((src[b] | (src[b + 1] << 8) | (src[b + 2] << 16)) >>> (at & 7)) & mask;
        } else {
            bits = pos > 0 ? (bitsAt(src, 0, pos) << -at) & mask : 0;
        }
        out[i] = symbol[bits];
        pos -= length[bits];
    }
    if (pos !== 0) fail('a Huffman stream that does not end where its literals do');
}

/** The sequences of a block (3.1.1.3.2), carried out as they are read: literals, then a match. */
function sequences(src, count, literals, state, out) {
    const { ll, of, ml, rep } = state;
    const stream = backward(src);
    let llState = stream.read(ll.log);
    let ofState = stream.read(of.log);
    let mlState = stream.read(ml.log);
    let lit = 0;
    for (let i = 0; i < count; i++) {
        const ofCode = of.symbol[ofState];
        const llCode = ll.symbol[llState];
        const mlCode = ml.symbol[mlState];
        if (llCode > 35 || mlCode > 52 || ofCode > 31) fail('a sequence code out of range');
        const value = 2 ** ofCode + stream.read(ofCode);
        const matchLength = ML_BASE[mlCode] + stream.read(ML_BITS[mlCode]);
        const literalLength = LL_BASE[llCode] + stream.read(LL_BITS[llCode]);
        if (i < count - 1) {
            llState = ll.base[llState] + stream.read(ll.bits[llState]);
            mlState = ml.base[mlState] + stream.read(ml.bits[mlState]);
            ofState = of.base[ofState] + stream.read(of.bits[ofState]);
        }

        // Values 1 to 3 repeat a recent offset (3.1.1.5); with no literals before the match, the next one.
        let offset;
        if (value > 3) {
            offset = value - 3;
            rep[2] = rep[1];
            rep[1] = rep[0];
            rep[0] = offset;
        } else {
            const index = value - 1 + (literalLength === 0 ? 1 : 0);
            if (index === 0) offset = rep[0];
            else {
                offset = index < 3 ? rep[index] : rep[0] - 1;
                if (index > 1) rep[2] = rep[1];
                rep[1] = rep[0];
                rep[0] = offset;
            }
        }

        if (lit + literalLength > literals.length) fail('a sequence takes more literals than there are');
        copyOut(out, literals, lit, literalLength);
        lit += literalLength;
        const start = out.pos - offset;
        if (offset < 1 || start < 0) fail('a match reaches back past what was unpacked');
        if (out.pos + matchLength > out.limit) fail('a block unpacks to more than 128 KB');
        const buf = out.buf;
        if (offset >= matchLength && matchLength > 32) buf.copyWithin(out.pos, start, start + matchLength);
        else for (let k = 0; k < matchLength; k++) buf[out.pos + k] = buf[start + k];
        out.pos += matchLength;
    }
    if (stream.at !== 0) fail('a sequences stream that does not end where its sequences do');
    copyOut(out, literals, lit, literals.length - lit);
}

function copyOut(out, literals, from, count) {
    if (count === 0) return;
    if (out.pos + count > out.limit) fail('a block unpacks to more than 128 KB');
    out.buf.set(literals.subarray(from, from + count), out.pos);
    out.pos += count;
}

/**
 * A bit stream read backward (4.1): it starts below the highest set bit of its last byte, and bits wanted from before
 * its start read as zeros (at goes below 0: a stream that ran out).
 */
function backward(src) {
    const last = src[src.length - 1];
    if (!last) fail('a bit stream with no end mark');
    const stream = {
        at: src.length * 8 - 8 + highBit(last),
        read(n) {
            if (n === 0) return 0;
            stream.at -= n;
            return stream.at >= 0 ? bitsAt(src, stream.at, n) : stream.at + n > 0 ? bitsAt(src, 0, stream.at + n) * 2 ** -stream.at : 0;
        },
    };

    return stream;
}

/** $n bits of $src from bit $at, the lowest first, as a number; bits past the end read as zeros. */
function bitsAt(src, at, n) {
    if (n > 24) return bitsAt(src, at, 24) + bitsAt(src, at + 24, n - 24) * 2 ** 24;
    const i = at >>> 3;
    const v = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);

    return (v >>> (at & 7)) & ((1 << n) - 1);
}

/** An FSE table from its description at byte $from (4.1.1): {table, size}, size being the description's bytes. */
function readFseTable(src, from, maxLog) {
    let at = from * 8;
    const log = bitsAt(src, at, 4) + 5;
    at += 4;
    if (log > maxLog) fail('an FSE table too precise');
    let remaining = 1 << log;
    const counts = [];
    while (remaining > 0) {
        if (counts.length > 255) fail('an FSE table of too many symbols');
        // Values up to remaining + 1 in as many bits as that takes; the smaller ones in a bit less.
        const bits = highBit(remaining + 1) + 1;
        const low = (1 << (bits - 1)) - 1;
        const threshold = (1 << bits) - 1 - (remaining + 1);
        let value = bitsAt(src, at, bits);
        if ((value & low) < threshold) {
            value &= low;
            at += bits - 1;
        } else {
            at += bits;
            if (value > low) value -= threshold;
        }
        const count = value - 1;
        remaining -= Math.abs(count);
        counts.push(count);
        // A zero count is followed by how many more there are, two bits at a time.
        if (count === 0) {
            for (let repeat = 3; repeat === 3; ) {
                repeat = bitsAt(src, at, 2);
                at += 2;
                for (let k = 0; k < repeat; k++) counts.push(0);
            }
        }
    }
    if (remaining !== 0 || at > src.length * 8) fail('an FSE table that does not add up');

    return { table: fseTable(counts, log), size: Math.ceil(at / 8) - from };
}

/**
 * The decoding table of a distribution (4.1.1): the "less than 1" symbols at its end, the others spread over it; a
 * state names its symbol, the bits to read and what they add to.
 */
function fseTable(counts, log) {
    const size = 1 << log;
    const symbol = new Uint8Array(size);
    const bits = new Uint8Array(size);
    const base = new Uint16Array(size);
    const next = new Uint16Array(counts.length);
    let high = size;
    counts.forEach((c, s) => {
        if (c === -1) {
            symbol[--high] = s;
            next[s] = 1;
        }
    });
    const step = (size >> 1) + (size >> 3) + 3;
    let pos = 0;
    counts.forEach((c, s) => {
        if (c <= 0) return;
        next[s] = c;
        for (let i = 0; i < c; i++) {
            symbol[pos] = s;
            do pos = (pos + step) & (size - 1);
            while (pos >= high);
        }
    });
    if (pos !== 0) fail('an FSE table that does not add up');
    for (let i = 0; i < size; i++) {
        const n = next[symbol[i]]++;
        bits[i] = log - highBit(n);
        base[i] = (n << bits[i]) - size;
    }

    return { log, symbol, bits, base };
}

const rleTable = (s) => ({ log: 0, symbol: Uint8Array.of(s), bits: Uint8Array.of(0), base: Uint16Array.of(0) });

function defaultTable(kind) {
    if (!defaults.has(kind)) defaults.set(kind, fseTable(...kind));

    return defaults.get(kind);
}
