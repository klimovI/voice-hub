package sfu

import (
	"fmt"
	"sync/atomic"
	"testing"
)

// BenchmarkLookupPublisherContention measures throughput of concurrent
// lookupPublisher calls — the forwardSubscriberRTCP hot path — with N
// goroutines reading simultaneously (simulating N subscriber senders).
//
// Run with:
//
//	go test -bench BenchmarkLookupPublisherContention -benchmem \
//	        -benchtime=5s -count=3 ./internal/sfu/
func BenchmarkLookupPublisherContention(b *testing.B) {
	for _, readers := range []int{1, 4, 8, 16} {
		b.Run(fmt.Sprintf("readers=%d", readers), func(b *testing.B) {
			r := &Room{publishers: make(map[string]publisherRef)}
			const key = "peer1:audio"
			r.publishers[key] = publisherRef{ssrc: 1, lastKeyframeNS: &atomic.Int64{}}
			b.ResetTimer()
			b.SetParallelism(readers)
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					r.lookupPublisher(key)
				}
			})
		})
	}
}
