import { LandingMotionProvider } from "@/components/landing-motion-provider"

import { MobileLandingCollaboration } from "@/components/mobile-landing/mobile-landing-collaboration"
import {
  MobileLandingStickyCta,
  MobileLandingTail,
} from "@/components/mobile-landing/mobile-landing-cta"
import { MobileLandingEvents } from "@/components/mobile-landing/mobile-landing-events"
import { MobileLandingGovernance } from "@/components/mobile-landing/mobile-landing-governance"
import { MobileLandingHero } from "@/components/mobile-landing/mobile-landing-hero"
import { MobileLandingNav } from "@/components/mobile-landing/mobile-landing-nav"
import { MobileLandingPlugins } from "@/components/mobile-landing/mobile-landing-plugins"
import { MobileLandingReach } from "@/components/mobile-landing/mobile-landing-reach"
import { MobileLandingShare } from "@/components/mobile-landing/mobile-landing-share"
import { MobileLandingTalent } from "@/components/mobile-landing/mobile-landing-talent"

export default function MobileHomePage() {
  return (
    <main className="relative min-h-svh overflow-x-hidden bg-[linear-gradient(180deg,#f3f9ff_0%,#f6f8fb_36%,#ffffff_100%)] text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.03)_1px,transparent_1px)] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.5),transparent_70%)] bg-[size:22px_22px]" />

      <LandingMotionProvider>
        <MobileLandingNav />
        <MobileLandingHero />
        <MobileLandingCollaboration />
        <MobileLandingShare />
        <MobileLandingTalent />
        <MobileLandingPlugins />
        <MobileLandingReach />
        <MobileLandingEvents />
        <MobileLandingGovernance />
        <MobileLandingTail />
        <MobileLandingStickyCta />
      </LandingMotionProvider>
    </main>
  )
}
