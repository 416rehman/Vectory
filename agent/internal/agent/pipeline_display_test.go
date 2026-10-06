package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// A state file written before the display fields existed holds the identity of
// the five original fields. It must still be the identity of the same desired
// version now, byte for byte, or every device would refuse the same generation.
func TestDesiredIdentityIsTheOriginalFiveFields(t *testing.T) {
	sha := Digest([]byte(`{"sources":{}}`))
	desired := &Desired{VersionID: "v2", SHA256: sha, Size: 14, ArtifactPath: "/agent/v1/artifacts/" + sha, VectorVersion: VectorVersion}
	original := `{"version_id":"v2","sha256":"` + sha + `","size":14,"artifact_path":"/agent/v1/artifacts/` + sha + `","vector_version":"` + VectorVersion + `"}`
	if got, want := Identity(desired), Digest([]byte(original)); got != want {
		t.Fatalf("identity %s, want the digest of the original marshalling %s", got, want)
	}
	named := *desired
	named.ConfigurationName, named.VersionNumber = "Edge syslog", 7
	if Identity(&named) != Identity(desired) {
		t.Fatal("the display fields are part of the identity")
	}
	if Identity((*Desired)(nil)) != Digest([]byte("null")) {
		t.Fatal("no desired version has another identity than before")
	}
}

// A rename at the same generation is accepted; so is a manifest that gains the
// two fields for a generation an older server delivered without them; a change
// to anything that identifies the artifact is refused.
func TestSameGenerationManifestsMayChangeOnlyTheDisplayFields(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	trust := base64.StdEncoding.EncodeToString(pub)
	older := sampleManifest() // generation 2, delivered with no display fields
	// The identity an older build stored: the digest of the original marshalling.
	sha := older.Desired.SHA256
	stored := Digest([]byte(`{"version_id":"v2","sha256":"` + sha + `","size":14,"artifact_path":"/agent/v1/artifacts/` + sha + `","vector_version":"` + VectorVersion + `"}`))
	st := State{Accepted: true, HighestGeneration: 2, HighestPolicyGeneration: 3, DesiredIdentity: stored, PolicyIdentity: Identity(older.Policy)}
	verify := func(change func(*Manifest)) error {
		m := older
		d := *older.Desired
		m.Desired = &d
		change(&m)
		_, err := VerifyEnvelope(signed(t, m, key), trust, "device-a", "nonce", older.IssuedAt, st)
		return err
	}
	accepted := map[string]func(*Manifest){
		"unchanged":            func(*Manifest) {},
		"gains both fields":    func(m *Manifest) { m.Desired.ConfigurationName, m.Desired.VersionNumber = "Edge syslog", 3 },
		"renamed":              func(m *Manifest) { m.Desired.ConfigurationName, m.Desired.VersionNumber = "Edge syslog (new name)", 3 },
		"a new version number": func(m *Manifest) { m.Desired.ConfigurationName, m.Desired.VersionNumber = "Edge syslog", 4 },
		"loses both fields":    func(m *Manifest) { m.Desired.ConfigurationName, m.Desired.VersionNumber = "", 0 },
		"a validation request": func(m *Manifest) {
			m.Features, m.Validation = []string{featureValidation}, json.RawMessage(`{"id":"x"}`)
		},
		"a malformed validation":    func(m *Manifest) { m.Validation = json.RawMessage(`{"id":5,"size":"big"}`) },
		"a validation of any shape": func(m *Manifest) { m.Validation = json.RawMessage(`[1,2,3]`) },
		"a validation that is null": func(m *Manifest) { m.Validation = json.RawMessage(`null`) },
	}
	for name, change := range accepted {
		t.Run("accepts "+name, func(t *testing.T) {
			if err := verify(change); err != nil {
				t.Fatal(err)
			}
		})
	}
	refused := map[string]func(*Manifest){
		"another sha256": func(m *Manifest) {
			m.Desired.SHA256 = Digest([]byte("other"))
			m.Desired.ArtifactPath = "/agent/v1/artifacts/" + m.Desired.SHA256
		},
		"another size":          func(m *Manifest) { m.Desired.Size = 15 },
		"another version id":    func(m *Manifest) { m.Desired.VersionID = "v3" },
		"another artifact path": func(m *Manifest) { m.Desired.ArtifactPath += "/" },
		"another vector version": func(m *Manifest) {
			m.Desired.VectorVersion = "0.58.1"
		},
		"a renamed version that also changes its content": func(m *Manifest) {
			m.Desired.ConfigurationName, m.Desired.VersionNumber, m.Desired.VersionID = "Renamed", 9, "v9"
		},
	}
	for name, change := range refused {
		t.Run("refuses "+name, func(t *testing.T) {
			if err := verify(change); err == nil || !strings.Contains(err.Error(), "same-generation desired identity changed") && !strings.Contains(err.Error(), "invalid artifact metadata") {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

// What a manifest says about the version is read leniently: a value that isn't
// well formed is no value, and never a reason to refuse the manifest.
func TestDisplayFieldsAreReadLeniently(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	trust := base64.StdEncoding.EncodeToString(pub)
	base := sampleManifest()
	read := func(fields string) Desired {
		t.Helper()
		desired := map[string]any{}
		raw, _ := json.Marshal(base.Desired)
		_ = json.Unmarshal(raw, &desired)
		payload := mustJSONFor(map[string]any{"protocol_version": 1, "device_id": "device-a", "nonce": "nonce", "issued_at": base.IssuedAt, "expires_at": base.ExpiresAt, "generation": 2, "policy_generation": 3, "policy": base.Policy, "desired": desired})
		// Add the fields as the server would write them, text and all.
		text := string(payload)
		text = strings.Replace(text, `"desired":{`, `"desired":{`+fields+`,`, 1)
		env := Envelope{Payload: base64.StdEncoding.EncodeToString([]byte(text)), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(text)))}
		m, err := VerifyEnvelope(env, trust, "device-a", "nonce", base.IssuedAt, State{})
		if err != nil {
			t.Fatalf("a manifest with %s was refused: %v", fields, err)
		}
		return *m.Desired
	}
	long := strings.Repeat("a", maxDisplayName)
	cases := []struct {
		fields string
		name   string
		number displayNumber
	}{
		{`"configuration_name":"Edge syslog","version_number":3`, "Edge syslog", 3},
		{`"configuration_name":"پایپ‌لاین بررسی","version_number":9007199254740991`, "پایپ‌لاین بررسی", 9007199254740991},
		{`"configuration_name":"Orders 🚚","version_number":1`, "Orders 🚚", 1},
		{`"configuration_name":"` + long + `","version_number":2`, long, 2},
		{`"configuration_name":"` + long + `a","version_number":2`, "", 2},
		{`"configuration_name":"","version_number":2`, "", 2},
		{`"configuration_name":"   ","version_number":2`, "", 2},
		{`"configuration_name":"a\u0000b","version_number":2`, "", 2},
		{`"configuration_name":"line\nbreak","version_number":2`, "", 2},
		{`"configuration_name":"escape\u001b[2J","version_number":2`, "", 2},
		{`"configuration_name":"‮evil","version_number":2`, "", 2},
		{`"configuration_name":"split line","version_number":2`, "", 2},
		{`"configuration_name":7,"version_number":"3"`, "", 0},
		{`"configuration_name":["x"],"version_number":{"n":1}`, "", 0},
		{`"configuration_name":null,"version_number":null`, "", 0},
		{`"version_number":0`, "", 0},
		{`"version_number":-4`, "", 0},
		{`"version_number":1.5`, "", 0},
		{`"version_number":3.0`, "", 0},
		{`"version_number":9007199254740992`, "", 0},
		{`"version_number":1e3`, "", 0},
		{`"version_number":true`, "", 0},
	}
	for _, c := range cases {
		t.Run(c.fields, func(t *testing.T) {
			got := read(c.fields)
			if string(got.ConfigurationName) != c.name || got.VersionNumber != c.number {
				t.Fatalf("name %q number %d, want %q and %d", got.ConfigurationName, got.VersionNumber, c.name, c.number)
			}
			if _, _, ok := got.pipeline(); ok != (c.name != "" && c.number != 0) {
				t.Fatalf("pipeline() = %v with name %q and number %d", ok, c.name, c.number)
			}
		})
	}
}

// The applied version is recorded from the manifest that delivered it, and a
// confirmation under a new name refreshes the name, not the version.
func TestTheAppliedVersionIsRecordedAndRefreshedFromTheVerifiedManifest(t *testing.T) {
	d := newCheckDevice(t)
	named := func(name string, number displayNumber) {
		d.plane.with(func(m *Manifest) {
			desired := *m.Desired
			desired.ConfigurationName, desired.VersionNumber = displayName(name), number
			m.Desired = &desired
		})
	}
	d.poll()
	if d.e.State.Applied == nil || d.e.State.Applied.VersionID != "v1" || d.e.State.Applied.Generation != 2 {
		t.Fatalf("applied %+v", d.e.State.Applied)
	}
	if _, _, ok := d.e.State.Applied.pipeline(); ok {
		t.Fatal("an older server named a version")
	}
	named("Edge syslog", 3)
	d.poll()
	if name, number, ok := d.e.State.Applied.pipeline(); !ok || name != "Edge syslog" || number != 3 {
		t.Fatalf("applied %+v", d.e.State.Applied)
	}
	named("Edge syslog processing", 3) // a rename: the same generation
	d.poll()
	if name, _, _ := d.e.State.Applied.pipeline(); name != "Edge syslog processing" {
		t.Fatalf("the rename didn't reach the device: %+v", d.e.State.Applied)
	}
	durable, err := LoadState(d.state)
	if err != nil || durable.Applied == nil || string(durable.Applied.ConfigurationName) != "Edge syslog processing" || durable.Desired.ConfigurationName != "Edge syslog processing" {
		t.Fatalf("durable state: %+v %v", durable.Applied, err)
	}
}

// A version that fails and is rolled back leaves the applied version as it was,
// with its name, while the desired one is the newer.
func TestARolledBackVersionLeavesTheAppliedOneNamed(t *testing.T) {
	d := newCheckDevice(t)
	d.plane.with(func(m *Manifest) {
		desired := *m.Desired
		desired.ConfigurationName, desired.VersionNumber = "Edge syslog", 3
		m.Desired = &desired
	})
	d.poll()
	next := &Desired{VersionID: "v4", SHA256: Digest(newConfig), Size: int64(len(newConfig)), ArtifactPath: "/agent/v1/artifacts/" + Digest(newConfig), VectorVersion: VectorVersion, ConfigurationName: "Edge syslog", VersionNumber: 4}
	d.plane.offer(next.ArtifactPath, newConfig)
	d.plane.with(func(m *Manifest) { m.Generation, m.Desired = 3, next })
	d.driver.fakeDriver.failNext = true // the new version doesn't start
	_ = d.e.Poll(context.Background())
	if d.e.State.ApplyState != "rolled_back" {
		t.Fatalf("apply state %s", d.e.State.ApplyState)
	}
	if _, number, ok := d.e.State.Applied.pipeline(); !ok || number != 3 || d.e.State.Applied.VersionID != "v1" {
		t.Fatalf("applied %+v", d.e.State.Applied)
	}
	if _, number, _ := d.e.State.Desired.pipeline(); number != 4 {
		t.Fatalf("desired %+v", d.e.State.Desired)
	}
}
