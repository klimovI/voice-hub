package sfu

import (
	"testing"

	"github.com/pion/rtp"
)

func audioRTPWithExtensions() []byte {
	pkt := &rtp.Packet{}
	pkt.Version = 2
	pkt.PayloadType = 111
	pkt.SequenceNumber = 1
	pkt.SSRC = 0xDEADBEEF
	_ = pkt.Header.SetExtension(1, []byte{0xAB})
	_ = pkt.Header.SetExtension(3, []byte{0x01, 0x02})
	pkt.Payload = make([]byte, 160)
	b, _ := pkt.Marshal()
	return b
}

func BenchmarkOnTrackExtensionStrip_Nil(b *testing.B) {
	buf := audioRTPWithExtensions()
	pkt := &rtp.Packet{}
	b.ReportAllocs()
	for b.Loop() {
		if err := pkt.Unmarshal(buf); err != nil {
			b.Fatal(err)
		}
		pkt.Extension = false
		pkt.Extensions = nil
	}
}

func BenchmarkOnTrackExtensionStrip_Retain(b *testing.B) {
	buf := audioRTPWithExtensions()
	pkt := &rtp.Packet{}
	b.ReportAllocs()
	for b.Loop() {
		if err := pkt.Unmarshal(buf); err != nil {
			b.Fatal(err)
		}
		pkt.Extension = false
		pkt.Extensions = pkt.Extensions[:0]
	}
}
