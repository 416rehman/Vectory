package agent

import (
	"os"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// Every way an offer can be wrong is refused before one byte of a build is
// downloaded, with the code of the contract, and a build is never staged for it. The
// host tells the server which release it refused and why.

func otherPlatform(version string) ReleaseArtifact {
	build := []byte("a build for another platform")
	artifact := ReleaseArtifact{OS: "windows", Arch: "amd64", Format: "executable", File: "vectory-" + version + "-windows-amd64.exe", Size: int64(len(build)), SHA256: Digest(build)}
	if runtime.GOOS == "windows" {
		artifact.OS, artifact.File = "linux", "vectory-"+version+"-linux-amd64"
	}
	return artifact
}

// Every refusal but one stages nothing at all. The one is a fork of a pinned key, which
// is handed to the update step as evidence with no build: see update_offer_fork_test.go.
func TestEveryRefusalHappensBeforeAnyDownloadAndStagesNothing(t *testing.T) {
	attempted := func(rig *offerRig) map[string]uint64 { return map[string]uint64{rig.public.Fingerprint(): 7} }
	for _, tc := range []struct {
		name  string
		setup func(*testing.T, *offerRig)
		code  string
		// noRelease: the offer is too broken to say which release it is about.
		noRelease bool
	}{
		{"a key the host doesn't pin signed it", func(t *testing.T, r *offerRig) {
			r.policy(func(p *UpdatePolicy) {
				p.Keys = []PinnedKey{{Key: testPublicKey(t, testPrivateKey(t, 2), "another"), PinnedAt: time.Now().UTC()}}
			})
		}, "KEY_NOT_PINNED", false},
		{"the signature is over other bytes", func(t *testing.T, r *offerRig) {
			other, err := BuildReleaseManifest(r.defaultRelease())
			if err != nil {
				t.Fatal(err)
			}
			other[len(other)-3] ^= 1
			r.offer(r.manifest, r.sign(other), nil)
		}, "SIGNATURE_INVALID", false},
		{"the release breaks a rule of its format and is signed anyway", func(t *testing.T, r *offerRig) {
			r.craft(func(m string) string { return strings.Replace(m, `"counter":7`, `"counter":7,"counter":8`, 1) })
		}, "MANIFEST_INVALID", false},
		{"the release has a member nobody defined", func(t *testing.T, r *offerRig) {
			r.craft(func(m string) string { return strings.Replace(m, `"counter":7`, `"counter":7,"turbo":true`, 1) })
		}, "MANIFEST_INVALID", false},
		{"the release was issued more than a day ahead of this host's clock", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) {
				m.IssuedAt = time.Now().UTC().Add(25 * time.Hour).Truncate(time.Second)
				m.ExpiresAt = m.IssuedAt.Add(24 * time.Hour)
			})
		}, "MANIFEST_INVALID", false},
		{"the release has expired", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) {
				m.IssuedAt = time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Second)
				m.ExpiresAt = time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
			})
		}, "MANIFEST_EXPIRED", false},
		{"the offer's manifest isn't base64", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"manifest": "not base64 at all!"})
		}, "MANIFEST_INVALID", true},
		{"the offer carries no manifest", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"manifest": nil})
		}, "MANIFEST_INVALID", true},
		{"the offer has no artifact", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"artifact": nil})
		}, "MANIFEST_INVALID", false},
		{"the offer has no signatures", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"signatures": nil})
		}, "MANIFEST_INVALID", false},
		{"the offer's rollout isn't an id", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"rollout_id": "rollout-1"})
		}, "MANIFEST_INVALID", false},
		{"the offer carries more rollover statements than a host follows", func(t *testing.T, r *offerRig) {
			var envelopes []RolloverEnvelope
			for i := 0; i < 9; i++ {
				envelope, err := SignRollover(r.private, testPublicKey(t, testPrivateKey(t, byte(10+i)), "successor"), time.Now().UTC().Truncate(time.Second))
				if err != nil {
					t.Fatal(err)
				}
				envelopes = append(envelopes, envelope)
			}
			r.offer(r.manifest, r.signatures, envelopes)
		}, "MANIFEST_INVALID", false},
		{"the release has no build for this platform", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) { m.Artifacts = []ReleaseArtifact{otherPlatform(r.defaultVersion)} })
			// The server still names a build; it can't be this platform's.
			r.offerMember(map[string]any{"artifact": map[string]any{"sha256": otherPlatform(r.defaultVersion).SHA256, "size": otherPlatform(r.defaultVersion).Size, "path": updateReleasePath + otherPlatform(r.defaultVersion).SHA256}})
		}, "PLATFORM_NOT_IN_RELEASE", false},
		{"this build was tried here and rolled back", func(t *testing.T, r *offerRig) {
			r.step(func(s *UpdateStatus) {
				s.HighestCounters = attempted(r)
				s.Last = &UpdateLast{Release: r.releaseSHA, Outcome: UpdateOutcomeRolledBack, Code: "START_FAILED", At: time.Now().UTC().Truncate(time.Second), FromVersion: r.e.State.Agent.Version, ToVersion: r.defaultVersion}
			})
		}, "RELEASE_ALREADY_TRIED", false},
		{"the counter is at or below the highest this host attempted", func(t *testing.T, r *offerRig) {
			r.step(func(s *UpdateStatus) { s.HighestCounters = attempted(r) })
		}, "COUNTER_REPLAYED", false},
		{"the host already runs this version", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) {
				m.Version = r.e.State.Agent.Version
				m.Artifacts = []ReleaseArtifact{platformArtifact(r.build, m.Version)}
			})
		}, "ALREADY_RUNNING", false},
		{"the version is older than the one that runs", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) {
				m.Version = "0.0.9"
				m.Artifacts = []ReleaseArtifact{platformArtifact(r.build, "0.0.9")}
			})
		}, "DOWNGRADE_REFUSED", false},
		{"the version isn't on the host's track", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) {
				offTrack, err := ParseReleaseVersion(r.e.State.Agent.Version)
				if err != nil {
					t.Fatal(err)
				}
				offTrack.Minor++
				offTrack.Patch = 0
				m.Version = offTrack.String()
				m.Artifacts = []ReleaseArtifact{platformArtifact(r.build, m.Version)}
			})
		}, "VERSION_NOT_ON_TRACK", false},
		{"the release can't be taken from the version that runs", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) { m.MinFrom = r.defaultVersion })
		}, "AGENT_TOO_OLD", false},
		{"the release needs a newer service definition", func(t *testing.T, r *offerRig) {
			r.release(func(m *ReleaseManifest) { m.ServiceDefinition = 2 })
		}, "SERVICE_DEFINITION_OUTDATED", false},
		{"the offer names another build than the release's for this platform", func(t *testing.T, r *offerRig) {
			other := Digest([]byte("another build"))
			r.offerMember(map[string]any{"artifact": map[string]any{"sha256": other, "size": len(r.build), "path": updateReleasePath + other}})
		}, "MANIFEST_INVALID", false},
		{"the offer names the right build at another size", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"artifact": map[string]any{"sha256": r.buildSHA, "size": len(r.build) + 1, "path": updateReleasePath + r.buildSHA}})
		}, "MANIFEST_INVALID", false},
		{"the offer's path leads to another digest", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"artifact": map[string]any{"sha256": r.buildSHA, "size": len(r.build), "path": updateReleasePath + Digest([]byte("another build"))}})
		}, "MANIFEST_INVALID", false},
		{"the offer's path is somewhere else on the server", func(t *testing.T, r *offerRig) {
			r.offerMember(map[string]any{"artifact": map[string]any{"sha256": r.buildSHA, "size": len(r.build), "path": "/agent/v1/artifacts/" + r.buildSHA}})
		}, "MANIFEST_INVALID", false},
		{"the host is installed from a package", func(t *testing.T, r *offerRig) {
			r.step(func(s *UpdateStatus) { s.Eligibility = "PACKAGE_MANAGED" })
		}, "PACKAGE_MANAGED", false},
		{"the host has no service that runs this agent", func(t *testing.T, r *offerRig) {
			r.step(func(s *UpdateStatus) { s.Eligibility = "NO_SERVICE" })
		}, "NO_SERVICE", false},
		{"the step can't write to the install directory", func(t *testing.T, r *offerRig) {
			r.step(func(s *UpdateStatus) { s.Eligibility = "READ_ONLY" })
		}, "READ_ONLY", false},
		{"the step hasn't run in the last two minutes", func(t *testing.T, r *offerRig) {
			r.step(func(s *UpdateStatus) { s.RunAt = time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second) })
		}, "HELPER_NOT_RUNNING", false},
		{"the step has never run", func(t *testing.T, r *offerRig) {
			if err := os.Remove(r.paths.Status); err != nil {
				t.Fatal(err)
			}
		}, "HELPER_NOT_RUNNING", false},
		{"the step recorded a fork of the pinned key", func(t *testing.T, r *offerRig) {
			r.step(func(s *UpdateStatus) {
				s.RolloverConflict = &RolloverConflict{From: r.public.Fingerprint(), To: [2]string{strings.Repeat("2", 64), strings.Repeat("3", 64)}}
			})
		}, "KEY_ROLLOVER_CONFLICT", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newOfferRig(t)
			tc.setup(t, rig)
			rig.poll()
			rig.poll()
			if rig.requests() != 0 {
				t.Fatalf("the build was asked for %d times", rig.requests())
			}
			if rig.e.update.download != nil {
				t.Fatal("a transfer began")
			}
			if names := rig.staged(); len(names) != 0 {
				t.Fatalf("a refused offer was staged: %v", names)
			}
			if _, err := os.Lstat(rig.exchange().Request); !os.IsNotExist(err) {
				t.Fatalf("a request was written: %v", err)
			}
			beat := rig.beat()
			if beat["state"] != "refused" || beat["code"] != tc.code {
				t.Fatalf("the host reports %v, want refused with %s", beat, tc.code)
			}
			if tc.noRelease {
				if beat["release"] != nil {
					t.Fatalf("an offer with no readable manifest names release %v", beat["release"])
				}
			} else if beat["release"] != rig.releaseSHA {
				t.Fatalf("the refusal is about %v, the release is %s", beat["release"], rig.releaseSHA)
			}
			if tc.code == "KEY_ROLLOVER_CONFLICT" {
				fork, _ := beat["rollover_conflict"].(map[string]any)
				to, _ := fork["to"].([]any)
				if fork == nil || fork["from"] != rig.public.Fingerprint() || len(to) != 2 || to[0] == to[1] {
					t.Fatalf("the fork is reported as %v", beat["rollover_conflict"])
				}
			} else if beat["rollover_conflict"] != nil {
				t.Fatalf("a fork where there is none: %v", beat["rollover_conflict"])
			}
			if tc.code == "ALREADY_RUNNING" {
				return // told to nobody: see TestAReleaseTheHostAlreadyRunsIsRefusedWithoutAWord
			}
			// The log says what the host refused, once, in words that are fixed.
			if !rig.said1("(" + tc.code + "): ") {
				t.Fatalf("the log said %q", rig.said)
			}
			count := 0
			for _, line := range rig.said {
				if strings.Contains(line, "("+tc.code+"): ") {
					count++
				}
			}
			rig.poll()
			for _, line := range rig.said {
				if strings.Contains(line, "("+tc.code+"): ") {
					count--
				}
			}
			if count != 0 {
				t.Fatalf("the refusal was said again at the next check-in: %q", rig.said)
			}
		})
	}
}

// A release signed by the successor of a pinned key is taken when the offer carries
// the statement that hands the key over, and the statement goes to the step with
// the rest of the offer. The host's pins are the step's to change, after the
// build proved itself.
func TestAReleaseSignedByTheSuccessorOfAPinnedKeyIsStagedWithItsStatement(t *testing.T) {
	rig := newOfferRig(t)
	successor := testPrivateKey(t, 7)
	successorKey := testPublicKey(t, successor, "team-next")
	envelope, err := SignRollover(rig.private, successorKey, time.Now().UTC().Truncate(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := BuildReleaseManifest(rig.defaultRelease())
	if err != nil {
		t.Fatal(err)
	}
	signatures, err := BuildReleaseSignatures([]ReleaseSignature{releaseSignatureBy(successorKey, successor.SignRelease(manifest))})
	if err != nil {
		t.Fatal(err)
	}
	// Without the statement, the successor's key is nobody the host knows.
	rig.offer(manifest, signatures, nil)
	rig.poll()
	rig.poll()
	if beat := rig.beat(); beat["code"] != "KEY_NOT_PINNED" || rig.requests() != 0 {
		t.Fatalf("%v", beat)
	}
	rig.offer(manifest, signatures, []RolloverEnvelope{envelope})
	rig.stageIt()
	rollovers, err := ReadUpdateRollovers(rig.stagedFile(UpdateRolloversFile))
	if err != nil || len(rollovers) != 1 || rollovers[0] != envelope {
		t.Fatalf("the statement didn't go to the step: %v %v", rollovers, err)
	}
	// The agent changes no pin: that is the step's, and only after a commit.
	policy, err := ReadUpdatePolicy()
	if err != nil || !slices.Equal(policy.Fingerprints(), []string{rig.public.Fingerprint()}) {
		t.Fatalf("the pins are %v (%v)", policy.Fingerprints(), err)
	}
	if beat := rig.beat(); beat["keys"].([]any)[0] != rig.public.Fingerprint() {
		t.Fatalf("the host reports %v", beat["keys"])
	}
}

// A release that already runs here is no news: a host that just installed it still
// sees it offered until the server has seen the new build check in.
func TestAReleaseTheHostAlreadyRunsIsRefusedWithoutAWord(t *testing.T) {
	rig := newOfferRig(t)
	rig.release(func(m *ReleaseManifest) {
		m.Version = rig.e.State.Agent.Version
		m.Artifacts = []ReleaseArtifact{platformArtifact(rig.build, m.Version)}
	})
	rig.poll()
	rig.poll()
	if beat := rig.beat(); beat["code"] != "ALREADY_RUNNING" {
		t.Fatalf("%v", beat)
	}
	if len(rig.said) != 0 {
		t.Fatalf("the log said %q", rig.said)
	}
}

// A refusal doesn't outlive the offer: when the manifest stops carrying it, the
// host is idle again.
func TestARefusalEndsWhenTheOfferDoes(t *testing.T) {
	rig := newOfferRig(t)
	rig.step(func(s *UpdateStatus) { s.Eligibility = "PACKAGE_MANAGED" })
	rig.poll()
	rig.poll()
	if beat := rig.beat(); beat["state"] != "refused" {
		t.Fatalf("%v", beat)
	}
	rig.withdraw()
	rig.poll()
	rig.poll()
	if beat := rig.beat(); beat["state"] != "idle" || beat["code"] != nil || beat["release"] != nil {
		t.Fatalf("a host with nothing offered reports %v", beat)
	}
}

// A refusal because of the step's state is lifted as soon as the step is back: the
// offer hasn't changed, and the host takes it.
func TestAHostThatCouldNotTakeAnUpdateTakesItWhenTheStepIsBack(t *testing.T) {
	rig := newOfferRig(t)
	rig.step(func(s *UpdateStatus) { s.RunAt = time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second) })
	rig.poll()
	rig.poll()
	if beat := rig.beat(); beat["code"] != "HELPER_NOT_RUNNING" || rig.requests() != 0 {
		t.Fatalf("%v, %d requests", beat, rig.requests())
	}
	rig.step(nil)
	rig.settle()
	rig.poll()
	if beat := rig.beat(); beat["state"] != "staged" || !slices.Contains(rig.staged(), rig.releaseSHA) {
		t.Fatalf("%v %v", beat, rig.staged())
	}
}
