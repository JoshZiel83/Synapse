import Image from "next/image"
import Link from "next/link"

import { FieldDescription } from "@/components/ui/field"

/**
 * Shared chrome for the login and signup pages: brand lockup on top, the form
 * card in the middle, legal links at the bottom. Keeping both auth surfaces on
 * one shell is what makes them feel like one standardized flow.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-6">
      <Link
        href="/"
        className="flex items-center gap-2 self-center text-base font-medium"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Image
            src="/synapse.svg"
            alt=""
            width={20}
            height={20}
            className="brightness-0 invert"
          />
        </span>
        Synapse
      </Link>
      {children}
      <FieldDescription className="px-6 text-center">
        By continuing, you agree to our{" "}
        <Link href="/login" className="underline-offset-2 hover:underline">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/login" className="underline-offset-2 hover:underline">
          Privacy Policy
        </Link>
        .
      </FieldDescription>
    </div>
  )
}
