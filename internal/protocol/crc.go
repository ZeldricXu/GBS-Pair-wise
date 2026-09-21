package protocol

import "hash/crc32"

// crcTable is the standard IEEE (zlib) table used by the device firmware.
var crcTable = crc32.MakeTable(crc32.IEEE)

// CRC returns the CRC32 checksum stored/expected in a frame trailer.
func CRC(data []byte) uint32 {
	return crc32.Checksum(data, crcTable)
}
