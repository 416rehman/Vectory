package agent

// The job a probe runs in on Windows. On Linux the step runs the build it probes as
// the service account, in a process group that is killed as a whole, inside the unit's
// sandbox. Windows has no switch of account that needs no password, and the step
// doesn't build a restricted token, so the probe runs as the step's own account, and
// what keeps it to the probe is time, the size of its output, a clean environment, and a
// job object: every process the build starts is in the job, and the job ends them all
// (update_probe_windows.go). The network and the file system stay open to it, and the
// documents say so.
//
// What the job's limits are is below as plain values, so that every platform can say
// what they are; the Windows tests read them back from a job the system made.

const (
	// The limit flags of a job object, with the values winnt.h gives them
	// (JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags).
	jobLimitActiveProcess  uint32 = 0x00000008 // JOB_OBJECT_LIMIT_ACTIVE_PROCESS
	jobLimitKillOnJobClose uint32 = 0x00002000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

	// probeActiveProcesses is how many processes the probe's job holds at once. The
	// probe runs `vectory version --json`, one process, and the system may give a
	// console program the console host that serves it, which is in the job too; the
	// rest is room for nothing the build has a reason to start.
	probeActiveProcesses = 4
)

// jobLimits are the limits of a job object a build runs in.
type jobLimits struct {
	// Flags are the limit flags: which limits the job has.
	Flags uint32
	// ActiveProcesses is how many processes the job holds at once, when Flags has
	// jobLimitActiveProcess.
	ActiveProcesses uint32
}

// probeJobLimits are the limits of the job the probe's process runs in.
//
// The job is closed when the probe ends, and jobLimitKillOnJobClose makes the system
// end every process in a job whose last handle is closed: the processes a build left
// behind end with it, and the handle belongs to the step alone (it is not inherited),
// so the system closes it when the step ends however it ends, and the build's whole
// tree ends with the step. The limit on active processes makes the system end a
// process that would be one too many, as it is made. No flag lets a process leave the
// job (neither breakaway nor silent breakaway).
func probeJobLimits() jobLimits {
	return jobLimits{Flags: jobLimitKillOnJobClose | jobLimitActiveProcess, ActiveProcesses: probeActiveProcesses}
}
