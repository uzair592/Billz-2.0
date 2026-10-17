import zlib from "node:zlib";

/**
 * Creates a valid ZIP buffer from an array of { name: string, data: Buffer | string }.
 * Follows standard PKZIP 2.0 format (uncompressed or deflate).
 */
export function createZipArchive(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const rawData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const nameBuffer = Buffer.from(file.name, "utf8");
    const compressedData = zlib.deflateRawSync(rawData);
    const crc = crc32(rawData);

    // Local file header (30 bytes + name + compressed)
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4);         // Version needed: 2.0
    localHeader.writeUInt16LE(0, 6);          // General purpose bit flag
    localHeader.writeUInt16LE(8, 8);          // Compression method: Deflate
    localHeader.writeUInt16LE(0, 10);         // Last mod file time
    localHeader.writeUInt16LE(0, 12);         // Last mod file date
    localHeader.writeUInt32LE(crc, 14);       // CRC-32
    localHeader.writeUInt32LE(compressedData.length, 18); // Compressed size
    localHeader.writeUInt32LE(rawData.length, 22);        // Uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26);     // File name length
    localHeader.writeUInt16LE(0, 28);                     // Extra field length
    nameBuffer.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedData);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central file header signature
    centralHeader.writeUInt16LE(20, 4);          // Version made by
    centralHeader.writeUInt16LE(20, 6);          // Version needed
    centralHeader.writeUInt16LE(0, 8);           // General purpose bit flag
    centralHeader.writeUInt16LE(8, 10);          // Compression method: Deflate
    centralHeader.writeUInt16LE(0, 12);          // Last mod time
    centralHeader.writeUInt16LE(0, 14);          // Last mod date
    centralHeader.writeUInt32LE(crc, 16);        // CRC-32
    centralHeader.writeUInt32LE(compressedData.length, 20); // Compressed size
    centralHeader.writeUInt32LE(rawData.length, 24);        // Uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28);     // File name length
    centralHeader.writeUInt16LE(0, 30);                     // Extra field length
    centralHeader.writeUInt16LE(0, 32);                     // File comment length
    centralHeader.writeUInt16LE(0, 34);                     // Disk number start
    centralHeader.writeUInt16LE(0, 36);                     // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);                     // External file attributes
    centralHeader.writeUInt32LE(offset, 42);                // Relative offset of local header
    nameBuffer.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) centralDirSize += ch.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                     // Number of this disk
  eocd.writeUInt16LE(0, 6);                     // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8);          // Number of central directory records on this disk
  eocd.writeUInt16LE(files.length, 10);         // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);       // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);     // Offset of central directory
  eocd.writeUInt16LE(0, 20);                    // Comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// Fast CRC-32 table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
