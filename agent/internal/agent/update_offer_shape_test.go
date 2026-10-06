package agent

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// The offer member is read the way the contract describes it. Members the contract
// doesn't list are ignored (a newer server may add some), every member it does
// list is needed, and every bound is kept.

func offerMemberJSON(t *testing.T, change func(map[string]any)) json.RawMessage {
	t.Helper()
	manifest := []byte(testManifest)
	member := map[string]any{
		"rollout_id": defaultRollout, "release_id": "7d2b9c40-1e35-4f6a-8b17-0c9e4d3a5f21",
		"manifest": base64.StdEncoding.EncodeToString(manifest), "signatures": base64.StdEncoding.EncodeToString([]byte(`{"schema":"x"}`)),
		"rollovers": []any{},
		"artifact":  map[string]any{"sha256": strings.Repeat("a", 64), "size": 15204352, "path": updateReleasePath + strings.Repeat("a", 64)},
	}
	if change != nil {
		change(member)
	}
	raw, err := json.Marshal(member)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAnOfferIsReadAsTheContractDescribesIt(t *testing.T) {
	offer, refusal := parseAgentOffer(offerMemberJSON(t, nil))
	if refusal != nil {
		t.Fatalf("%v", refusal)
	}
	if offer.RolloutID != defaultRollout || offer.ManifestSHA256 != Digest([]byte(testManifest)) || string(offer.Manifest) != testManifest ||
		offer.Artifact.Size != 15204352 || offer.Artifact.Path != updateReleasePath+strings.Repeat("a", 64) {
		t.Fatalf("%+v", offer)
	}

	for name, change := range map[string]func(map[string]any){
		"members nobody defined are ignored": func(m map[string]any) { m["release_version"] = "0.1.1"; m["artifact"].(map[string]any)["mirror"] = "x" },
		"no rollovers at all":                func(m map[string]any) { delete(m, "rollovers") },
		"null rollovers":                     func(m map[string]any) { m["rollovers"] = nil },
		"an artifact of one byte":            func(m map[string]any) { m["artifact"].(map[string]any)["size"] = 1 },
		"an artifact of the largest size":    func(m map[string]any) { m["artifact"].(map[string]any)["size"] = MaxAgentBuild },
	} {
		if _, refusal := parseAgentOffer(offerMemberJSON(t, change)); refusal != nil {
			t.Errorf("%s: refused: %v", name, refusal)
		}
	}

	for name, change := range map[string]func(map[string]any){
		"not an object at all":              nil,
		"no manifest":                       func(m map[string]any) { delete(m, "manifest") },
		"a manifest that isn't a string":    func(m map[string]any) { m["manifest"] = 7 },
		"a manifest with a line feed in it": func(m map[string]any) { m["manifest"] = "eyJh\nbGciOjF9" },
		"a manifest that isn't canonical":   func(m map[string]any) { m["manifest"] = "eyJhIjoxfQ" },
		"an empty manifest":                 func(m map[string]any) { m["manifest"] = "" },
		"a manifest over 16 KiB": func(m map[string]any) {
			m["manifest"] = base64.StdEncoding.EncodeToString(make([]byte, MaxReleaseManifest+1))
		},
		"no signatures": func(m map[string]any) { delete(m, "signatures") },
		"signatures over 4 KiB": func(m map[string]any) {
			m["signatures"] = base64.StdEncoding.EncodeToString(make([]byte, MaxReleaseSignatures+1))
		},
		"no rollout":                         func(m map[string]any) { delete(m, "rollout_id") },
		"a rollout in capitals":              func(m map[string]any) { m["rollout_id"] = strings.ToUpper(defaultRollout) },
		"a release that isn't an id":         func(m map[string]any) { m["release_id"] = "release" },
		"no artifact":                        func(m map[string]any) { delete(m, "artifact") },
		"an artifact with no path":           func(m map[string]any) { delete(m["artifact"].(map[string]any), "path") },
		"an artifact of no bytes":            func(m map[string]any) { m["artifact"].(map[string]any)["size"] = 0 },
		"an artifact over the largest":       func(m map[string]any) { m["artifact"].(map[string]any)["size"] = MaxAgentBuild + 1 },
		"an artifact with a fractional size": func(m map[string]any) { m["artifact"].(map[string]any)["size"] = 1.5 },
		"an artifact digest in capitals":     func(m map[string]any) { m["artifact"].(map[string]any)["sha256"] = strings.Repeat("A", 64) },
		"an artifact digest too short":       func(m map[string]any) { m["artifact"].(map[string]any)["sha256"] = strings.Repeat("a", 63) },
		"nine rollover statements": func(m map[string]any) {
			var envelopes []any
			for i := 0; i < 9; i++ {
				envelopes = append(envelopes, map[string]any{"statement": "e30=", "signature": base64.StdEncoding.EncodeToString(make([]byte, 64))})
			}
			m["rollovers"] = envelopes
		},
		"a rollover with no signature bytes": func(m map[string]any) {
			m["rollovers"] = []any{map[string]any{"statement": "e30=", "signature": ""}}
		},
		"a rollover statement over 1 KiB": func(m map[string]any) {
			m["rollovers"] = []any{map[string]any{"statement": base64.StdEncoding.EncodeToString(make([]byte, MaxRolloverStatement+1)), "signature": base64.StdEncoding.EncodeToString(make([]byte, 64))}}
		},
	} {
		raw := json.RawMessage(`"an offer"`)
		if change != nil {
			raw = offerMemberJSON(t, change)
		}
		_, refusal := parseAgentOffer(raw)
		if refusal == nil || refusal.Code != "MANIFEST_INVALID" {
			t.Errorf("%s: %v", name, refusal)
		}
	}
}

// Even an offer that is refused says which release it was about, when its manifest
// can be read at all: the report names the manifest's digest, never anything else.
func TestARefusedOfferNamesTheReleaseWhenItsManifestCanBeRead(t *testing.T) {
	offer, refusal := parseAgentOffer(offerMemberJSON(t, func(m map[string]any) { m["rollout_id"] = "nope" }))
	if refusal == nil || offer == nil || offer.ManifestSHA256 != Digest([]byte(testManifest)) {
		t.Fatalf("%v %+v", refusal, offer)
	}
	if offer, _ = parseAgentOffer(offerMemberJSON(t, func(m map[string]any) { m["manifest"] = "!!!" })); offer != nil && offer.ManifestSHA256 != "" {
		t.Fatalf("a digest of a manifest nobody could read: %+v", offer)
	}
}
