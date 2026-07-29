import Link from 'next/link';
import { BrandIcon } from '@/components/ui/brand-icon';

// Self-service registration is retired (1b Task 13 — spec §7: accounts are
// admin-invite-only via Authentik OIDC or the `scripts/admin/create-user.ts`
// CLI). This route is kept — not removed — as a public landing spot for
// anyone who follows a stale bookmark/link to the old sign-up flow, so it
// fails soft with next steps instead of a 404. See
// docs/runbooks/authentik-oidc-setup.md for the full invite flow.
export default function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 dark:bg-surface-900 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <BrandIcon size={48} className="mb-3" />
          <h1 className="text-xl font-bold text-surface-900 dark:text-surface-100">
            Accounts are invite-only
          </h1>
        </div>

        <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-6 space-y-4 dark:bg-surface-800 dark:border-surface-700 text-center">
          <p className="text-sm text-surface-600 dark:text-surface-300 leading-relaxed">
            Judge Arena doesn&apos;t support self-service sign-up. If you need
            access to this instance, contact your administrator — they can
            invite you via your organization&apos;s identity provider or
            create a direct-login account for you.
          </p>

          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-colors"
          >
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
}
