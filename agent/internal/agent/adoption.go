package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

// adoptionInventoryDir is the folder of the state directory that keeps what
// setup learned about a Vector that was running: one folder per inventory, with
// a copy of every configuration file it loads and the record of the inventory.
const adoptionInventoryDir = "adoption-inventory"

// adoptionRecordName is the record inside each inventory folder.
const adoptionRecordName = "inventory.json"

var backupNameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// backupFileName names the copy of the i-th file: the number keeps two files
// with the same name in different folders apart.
func backupFileName(i int, path string) string {
	base := backupNameUnsafe.ReplaceAllString(filepath.Base(filepath.FromSlash(path)), "_")
	if len(base) > 80 {
		base = base[len(base)-80:]
	}
	return fmt.Sprintf("%02d-%s", i+1, strings.TrimLeft(base, "."))
}

// writeAdoptionBackup copies every configuration file of the inventory into a
// private folder of the state directory and writes the record beside them. It
// creates the state directory when it is missing, and refuses a directory that
// holds unrelated files. Running setup again over the same Vector keeps the
// copies it made before instead of making more.
func writeAdoptionBackup(dir string, inventory *AdoptionInventory, taken time.Time) error {
	if err := adoptionLocalPath(dir); err != nil {
		return err
	}
	if err := CheckFreshStateDirectory(dir); err != nil {
		return err
	}
	if latest := latestAdoptionRecord(dir); latest != nil && latest.Fingerprint == inventory.Fingerprint && inventory.Fingerprint != "" {
		inventory.Files, inventory.BackupDir, inventory.TakenAt, inventory.AgentVersion = latest.Files, latest.BackupDir, latest.TakenAt, latest.AgentVersion
		return nil
	}
	if err := createFreshStateDirectory(dir); err != nil {
		return err
	}
	root := filepath.Join(dir, adoptionInventoryDir)
	for _, path := range []string{dir, root} {
		if err := PrivateDir(path); err != nil {
			return err
		}
	}
	folder := filepath.Join(root, taken.UTC().Format("20060102T150405Z"))
	for n := 2; ; n++ {
		if _, err := os.Lstat(folder); os.IsNotExist(err) {
			break
		}
		folder = filepath.Join(root, fmt.Sprintf("%s-%d", taken.UTC().Format("20060102T150405Z"), n))
	}
	if err := PrivateDir(folder); err != nil {
		return err
	}
	for i := range inventory.Files {
		file := &inventory.Files[i]
		if file.content == nil {
			continue
		}
		name := backupFileName(i, file.Path)
		copyPath := filepath.Join(folder, name)
		if err := AtomicWrite(copyPath, file.content); err != nil {
			return err
		}
		if digest, err := FileDigest(copyPath); err != nil || digest != file.SHA256 {
			return errors.New("the copy of " + file.Path + " doesn't match the file it was made from")
		}
		file.Backup = name
	}
	inventory.BackupDir = folder
	inventory.TakenAt = taken.UTC().Format(time.RFC3339)
	inventory.AgentVersion = Version
	return WriteJSON(filepath.Join(folder, adoptionRecordName), inventory)
}

// unreadableRecord stands for an inventory that is there and can't be read:
// setup stops for it rather than going ahead without knowing what it said.
func unreadableRecord(folder string, err error) *AdoptionInventory {
	detail := "The record of an earlier inventory (" + folder + ") can't be read"
	if err != nil {
		detail += ": " + describeReadError(err)
	}
	return &AdoptionInventory{BackupDir: folder, Concerns: []InventoryConcern{{Kind: "record_unreadable", Blocks: true, Detail: detail + "."}}}
}

// latestAdoptionRecord reads the newest inventory kept in a state directory:
// nil when there is none. A folder without a record is a copy that was never
// finished, and is passed over.
func latestAdoptionRecord(dir string) *AdoptionInventory {
	root := filepath.Join(dir, adoptionInventoryDir)
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return unreadableRecord(root, err)
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for i := len(names) - 1; i >= 0; i-- {
		folder := filepath.Join(root, names[i])
		var record AdoptionInventory
		err := ReadJSON(filepath.Join(folder, adoptionRecordName), &record)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return unreadableRecord(folder, err)
		}
		record.BackupDir = folder
		return &record
	}
	return nil
}

// acknowledgeAdoption marks the newest record as adopted explicitly.
func acknowledgeAdoption(inventory *AdoptionInventory) {
	inventory.Acknowledged = true
	if inventory.BackupDir != "" {
		_ = WriteJSON(filepath.Join(inventory.BackupDir, adoptionRecordName), inventory)
	}
}

// startupText is how one process was started, as a phrase.
func startupText(process VectorStartup) string {
	if len(process.Command) == 0 {
		return "(the host wouldn't say)"
	}
	text := displayCommand(process.Command)
	switch {
	case process.Source == "service":
		text += " (from the definition of " + process.Service + ", since the process itself couldn't be read)"
	case len(process.ServiceCommand) > 0 && !slices.Equal(process.ServiceCommand, process.Command):
		text += " (" + process.Service + " defines: " + displayCommand(process.ServiceCommand) + ")"
	}
	return text
}

// fileText is a file with its checksum, or why it has none.
func fileText(file AdoptionFile) string {
	path := printable(file.Path)
	switch {
	case file.tooLarge:
		return path + " (" + file.Problem + ")"
	case file.Problem != "":
		return path + " (can't be read: " + file.Problem + ")"
	case file.SHA256 != "":
		return path + " (sha256 " + file.SHA256[:12] + "…)"
	}
	return path
}

// Describe says how Vector was started and which configuration files it loads
// in one sentence per process ("Vector started with: …; configuration files:
// …, backed up to …"), then what was noticed that doesn't stop setup.
func (i AdoptionInventory) Describe() string {
	files := make([]string, len(i.Files))
	for n, file := range i.Files {
		files[n] = fileText(file)
	}
	list := "none found"
	if len(files) > 0 {
		list = strings.Join(files, ", ")
	}
	backup := ""
	if i.BackupDir != "" && len(i.Files) > 0 {
		backup = ", backed up to " + i.BackupDir
	}
	var b strings.Builder
	if len(i.Processes) == 1 {
		fmt.Fprintf(&b, "Vector started with: %s; configuration files: %s%s.", startupText(i.Processes[0]), list, backup)
	} else {
		for _, process := range i.Processes {
			fmt.Fprintf(&b, "Vector (pid %d) started with: %s\n", process.PID, startupText(process))
		}
		fmt.Fprintf(&b, "Configuration files: %s%s.", list, backup)
	}
	for _, concern := range i.Concerns {
		if !concern.Blocks {
			b.WriteString("\n" + concern.Detail)
		}
	}
	return b.String()
}

// stopAdvice is how to stop what runs: for a service, the command of this
// platform's service manager (systemd, or PowerShell on Windows).
func stopAdvice(running []RunningVector, goos string) string {
	for _, v := range running {
		if v.Service == "" {
			continue
		}
		switch goos {
		case "linux":
			return "stop it (for example: sudo systemctl disable --now " + v.Service + ")"
		case "windows":
			name := quoteArg(v.Service)
			return "stop it (for example, in an elevated PowerShell: Stop-Service -Name " + name + "; Set-Service -Name " + name + " -StartupType Disabled)"
		}
	}
	return "stop it"
}

// blockingDetails are the blocking concerns, one per line.
func (i AdoptionInventory) blockingDetails() string {
	var lines []string
	for _, concern := range i.Blocking() {
		lines = append(lines, concern.Detail)
	}
	return strings.Join(lines, "\n")
}

// refusal explains why the agent won't adopt a topology it doesn't manage, and
// how to consolidate it or to adopt it as it is. stop is the advice to stop
// the running Vector, or "" when none runs any more.
func (i AdoptionInventory) refusal(subject, managed, stop string) (detail, fix string) {
	detail = subject + "\n" + i.blockingDetails()
	kept := "what it loads stays where it is and no Vector started by Vectory reads it"
	if i.BackupDir != "" {
		kept = "what it loads stays where it is (backed up in " + i.BackupDir + ") and no Vector started by Vectory reads it"
	}
	fix = "Merge what it loads into one JSON file at " + managed + " (the Help center's Connect a device page, under Keep an existing workload, shows how), or adopt it as it is: the agent then manages only " + managed + "; " + kept + ". Either way, "
	if stop != "" {
		fix += stop + ", then "
	}
	return detail, fix + "run this command again with --adopt-existing."
}

// runningFix is what to do about a Vector that still runs when the refusal is
// only that it runs. Having chosen to adopt it as it is changes what is left
// to do: stop it and say the same again.
func (i AdoptionInventory) runningFix(managed, stop string, adopting bool) string {
	fix := "To hand its workload to Vectory, save its configuration as JSON at " + managed + ", " + stop + ", then run this command again. To leave it running untouched beside Vectory, add --keep-existing-vector."
	if adopting {
		fix = "You chose to adopt it as it is (--adopt-existing): " + stop + ", then run this command again with the same flag."
	}
	if i.BackupDir != "" && len(i.Files) > 0 {
		fix += " Its configuration is backed up in " + i.BackupDir + "."
	}
	return fix
}

// inventoryRunning records how the Vector processes that keep running were
// started, keeps a copy of their configuration and says so.
func (r *setupRun) inventoryRunning(ctx context.Context, running []RunningVector, dir string) AdoptionInventory {
	collect := r.host.collect
	if collect == nil {
		collect = collectStartups
	}
	inventory := InventoryVector(collect(ctx, running))
	inventory.AgentVersion = Version
	inventory.Acknowledged = r.options.AdoptExisting
	r.result.Adoption = &inventory
	var problem error
	if !r.options.DryRun {
		problem = writeAdoptionBackup(dir, &inventory, time.Now())
	}
	detail, status, fix := inventory.Describe(), "info", ""
	switch {
	case problem != nil:
		status, fix = "warn", "Nothing was copied: "+sentence(problem.Error())+" Copy the files yourself before you change them."
		if os.IsPermission(problem) || errors.Is(problem, os.ErrPermission) {
			fix = "Nothing was copied: " + sentence(problem.Error()) + " Run setup with sudo (administrator rights), or copy the files yourself before you change them."
		}
	case r.options.DryRun && len(inventory.Files) > 0:
		fix = "A real run copies them into " + filepath.Join(dir, adoptionInventoryDir) + "."
	}
	r.add("inventory", status, "Inventory", detail, fix)
	return inventory
}

// recordedAdoption looks at what an earlier run recorded about a Vector that
// ran on this host, now that none runs. A topology the agent doesn't manage
// stops setup until it is adopted explicitly. The last result says why setup
// must stop.
func (r *setupRun) recordedAdoption(dir, managed string) (detail, fix string, refuse bool) {
	record := latestAdoptionRecord(dir)
	if record == nil {
		return "", "", false
	}
	r.result.Adoption = record
	when := ""
	if parsed, err := time.Parse(time.RFC3339, record.TakenAt); err == nil {
		when = parsed.UTC().Format("2006-01-02 15:04 MST")
	}
	subject := "A Vector that ran here loaded configuration the agent doesn't manage:"
	if when != "" {
		subject = "A Vector that ran here (recorded " + when + ") loaded configuration the agent doesn't manage:"
	}
	switch {
	case len(record.Blocking()) == 0:
		detail := "An earlier run recorded the Vector that ran here. " + record.Describe()
		if when != "" {
			detail += "\nRecorded " + when + "."
		}
		r.add("inventory", "info", "Inventory", detail, "")
		return "", "", false
	case r.options.AdoptExisting:
		// A record that couldn't be read stays as it is, for inspection.
		if !r.options.DryRun && record.Fingerprint != "" {
			acknowledgeAdoption(record)
		}
		record.Acknowledged = true
		files := "its configuration files"
		if n := len(record.Files); n > 0 {
			files = fmt.Sprintf("its %d configuration file%s", n, pluralSuffix(n))
		}
		kept := fmt.Sprintf("Adopting the Vector that ran here as it is: the agent manages only %s. %s stay where they are", managed, strings.ToUpper(files[:1])+files[1:])
		if record.BackupDir != "" {
			kept += " (backed up in " + record.BackupDir + ")"
		}
		r.add("inventory", "info", "Inventory", kept+", and no Vector started by Vectory reads them.\n"+record.blockingDetails(), "")
		return "", "", false
	}
	detail, fix = record.refusal(subject, managed, "")
	return detail, fix, true
}
