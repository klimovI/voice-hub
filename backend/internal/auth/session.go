package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

const CookieName = "vh_session"

type Session struct {
	User    string
	Expires time.Time
}

func Encode(secret []byte, user string, ttl time.Duration) string {
	exp := time.Now().Add(ttl).Unix()
	payload := strconv.FormatInt(exp, 10) + ":" + user
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig
}

func Decode(secret []byte, value string) (Session, error) {
	idx := strings.LastIndexByte(value, '.')
	if idx < 0 {
		return Session{}, errors.New("malformed cookie")
	}
	payload, sig := value[:idx], value[idx+1:]
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return Session{}, errors.New("bad signature")
	}
	expStr, user, ok := strings.Cut(payload, ":")
	if !ok {
		return Session{}, errors.New("malformed payload")
	}
	expUnix, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return Session{}, errors.New("bad expiry")
	}
	expires := time.Unix(expUnix, 0)
	if time.Now().After(expires) {
		return Session{}, errors.New("expired")
	}
	return Session{User: user, Expires: expires}, nil
}
