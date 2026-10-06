//go:build linux || darwin

package agent

import (
	"context"
	"net/http"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTrustServerNewCAKeepsServiceReadAccess(t *testing.T) {
	ca := makeCA(t)
	server := trustedServer(t, ca, http.NotFoundHandler())
	dir, _, _, _ := enrolledTrustFixture(t, server.URL)
	settingsPath := filepath.Join(dir, "settings.json")
	giveAccess(t, settingsPath, 0640)
	want, _ := accessOf(t, settingsPath)
	file := filepath.Join(privateTempDir(t), "approved-ca.pem")
	if err := AtomicWrite(file, []byte(ca.pem)); err != nil {
		t.Fatal(err)
	}
	if _, err := TrustServer(context.Background(), dir, TrustServerOptions{Server: server.URL, CAFile: &file}); err != nil {
		t.Fatal(err)
	}
	settings, err := LoadSettings(dir)
	if err != nil {
		t.Fatal(err)
	}
	settingsAccess, _ := accessOf(t, settingsPath)
	caAccess, _ := accessOf(t, settings.CAFile)
	if !reflect.DeepEqual(settingsAccess, want) || !reflect.DeepEqual(caAccess, want) {
		t.Fatalf("trust repair changed the service account's access: wanted %+v, settings %+v, CA %+v", want, settingsAccess, caAccess)
	}
}
