import Image from "next/image"
import Link from "next/link"

/**
 * Shared chrome for the login and signup pages: brand lockup on top and the
 * form card below, so both auth surfaces stay in one consistent flow.
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
    </div>
  )
}
