package dd_test

import (
	"testing"

	"voice-hub/backend/internal/sfu/dd"
)

func TestNoopParserReturnsNilNil(t *testing.T) {
	t.Parallel()

	p := dd.NewParser()
	for _, in := range [][]byte{
		nil,
		{},
		{0x00, 0x00, 0x00},
		{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
	} {
		desc, err := p.Parse(in)
		if err != nil {
			t.Errorf("Parse(%v) err = %v, want nil", in, err)
		}
		if desc != nil {
			t.Errorf("Parse(%v) desc = %+v, want nil", in, desc)
		}
	}
}

func TestRTPExtensionURI(t *testing.T) {
	t.Parallel()

	if dd.RTPExtensionURI == "" {
		t.Fatal("RTPExtensionURI must not be empty")
	}
	// Sanity: must match the AV1 RTP spec URI (no trailing whitespace,
	// no scheme drift) so MediaEngine.RegisterHeaderExtension can match
	// the SDP-advertised URI byte-for-byte.
	const want = "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension"
	if dd.RTPExtensionURI != want {
		t.Errorf("RTPExtensionURI = %q, want %q", dd.RTPExtensionURI, want)
	}
}
