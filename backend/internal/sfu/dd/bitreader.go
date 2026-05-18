package dd

import "errors"

// errBitReaderEOF is returned when a read asks for more bits than remain in
// the buffer. It bubbles up through Parser.Parse and surfaces to the SFU
// forward path, which treats parse failures as "forward without layer info".
var errBitReaderEOF = errors.New("dd: not enough bits")

// bitReader walks an MSB-first bit stream over a byte slice. It is the
// minimal subset of bit-level operations the AV1 Dependency Descriptor
// parser needs: fixed-width reads up to 32 bits, single-bit booleans, and
// the AV1 non-symmetric coding used for chain counts.
//
// Not safe for concurrent use. One reader per Parse call; reused across
// fields of the same packet.
type bitReader struct {
	buf    []byte
	bitPos int
}

func newBitReader(buf []byte) *bitReader { return &bitReader{buf: buf} }

func (r *bitReader) remaining() int { return len(r.buf)*8 - r.bitPos }

// ok returns false once the reader has been read past the end of the buffer.
// Used to bound the template-layer loop in the structure parser, which is
// otherwise self-terminating.
func (r *bitReader) ok() bool { return r.remaining() > 0 }

// read pulls n bits (0 ≤ n ≤ 32) into the low bits of the returned uint32.
// MSB-first. read(0) returns 0 with no error and consumes no bits (the AV1
// non-symmetric coding hits this case when numValues == 1).
func (r *bitReader) read(n int) (uint32, error) {
	if n < 0 || n > 32 {
		return 0, errors.New("dd: bit count out of range")
	}
	if n == 0 {
		return 0, nil
	}
	if r.remaining() < n {
		return 0, errBitReaderEOF
	}
	var v uint32
	for n > 0 {
		byteIdx := r.bitPos / 8
		bitOff := r.bitPos % 8
		bitsLeft := 8 - bitOff
		take := bitsLeft
		if n < take {
			take = n
		}
		shift := bitsLeft - take
		mask := byte((1 << take) - 1)
		chunk := (r.buf[byteIdx] >> shift) & mask
		v = (v << take) | uint32(chunk)
		r.bitPos += take
		n -= take
	}
	return v, nil
}

func (r *bitReader) readBool() (bool, error) {
	v, err := r.read(1)
	return v != 0, err
}

// readNS decodes one non-symmetric value in [0, numValues-1]. The encoding
// (AV1 spec §4.10.7 ns(n)) packs values densely into ⌈log2(numValues)⌉
// bits without the wastage of a plain fixed-width field — useful here for
// chain counts that vary 0..(numDecodeTargets+1) inclusive.
//
// numValues == 0 is undefined per spec; we treat it as "one possible value"
// and return 0 without consuming bits to keep the parser robust to malformed
// inputs.
func (r *bitReader) readNS(numValues uint32) (uint32, error) {
	if numValues <= 1 {
		return 0, nil
	}
	width := 0
	for x := numValues; x > 0; x >>= 1 {
		width++
	}
	k := (uint32(1) << width) - numValues

	v, err := r.read(width - 1)
	if err != nil {
		return 0, err
	}
	if v < k {
		return v, nil
	}
	extra, err := r.read(1)
	if err != nil {
		return 0, err
	}
	return (v << 1) + extra - k, nil
}
