package agent

// The release gate. An operating system's agent updates ship only when that
// system's native proof, on a real service, is green at the cut. One whose proof
// isn't has no host here: every function of the step's API says that this build has
// no step for the platform, UpdateEligibility says PLATFORM_NOT_IN_RELEASE, setup
// refuses --updates ("Hosts of this kind update by hand in this release.") and the
// review lists the devices. That is a refusal, never a weaker mechanism.
//
// A platform keeps its gate where it keeps its host, and passes both through
// gatedUpdateHost, so that closing a gate is changing one word and nothing else
// about the step. The host is built only when the gate is open.
func gatedUpdateHost(inRelease bool, newHost func() updateHost) updateHost {
	if !inRelease {
		return nil
	}
	return newHost()
}
