# PortraitPop photographer licensing

Lets independent photographers (not YearbookLife customers) buy PortraitPop licenses and pass them to the schools they work with. **1 license = 1 school.** YearbookLife customers keep using PortraitPop from the dashboard, which is unchanged.

Address: **`https://yearbooklife-portal.vercel.app/pp`** (one page for photographers, school admins and YearbookLife staff; it shows the right view for whoever signs in).

## How it works

| Who | What they do |
|---|---|
| **YearbookLife staff** (emails in `PP_STAFF_EMAILS`) | Add a photographer. After their invoice is paid, add licenses (the page shows the tier price). Suspend a photographer if needed. Look up a license code from a PDF. |
| **Photographer** | Signs in with an emailed link. Sends a license to a school by entering the school's name, city, state and zip, plus the yearbook admin's name and email. Can resend the link, change the admin, reset devices, or remove the school. |
| **School yearbook admin** | Gets an email, signs in, clicks **Open PortraitPop**. The 60 days start at their first sign-in. |

**Pricing** (every license in an order is charged at the tier for the order size): 1–4 $80 · 5–19 $75 · 20–49 $70 · 50–99 $65 · 100–199 $60 · 200+ call for pricing (staff types the agreed price). Payment is invoiced manually; licenses are added once it's paid.

**Rules built in**
- Unused licenses never expire. A license ends 60 days after the school admin first signs in. Reminder emails go to the admin and photographer about a week before.
- **YearbookLife schools are blocked.** Before a license is used, the school is checked against HubSpot won deals for the current or next school year (or closed in the last 12 months): same cleaned-up school name in the same state or zip, or the admin's email belongs to a customer contact. Blocked → no license used. Close-but-unsure matches are allowed, and YearbookLife gets an email. That includes a similar name nearby, or an admin email on the same domain as a customer (like a shared district domain). If HubSpot can't be reached, nothing is sent and no license is used.
- **Mid-season flag:** every night, licensed schools are re-checked. If one now matches a YearbookLife deal, you get an email. Their access is not changed.
- **No "Print with YearbookLife"** on exports.
- Cancelling an invite the admin never used returns the license. Removing a school that has signed in does not.

**Sharing protection**
- Sign-in is by emailed link only. The link works once and lands on a page with a **Sign in** button (so email scanners can't use it up).
- The sign-in is kept in a secure cookie the page can't read. A saved or forwarded copy of the PortraitPop page can't export.
- One computer at a time per school. Signing in somewhere new signs the other computer out.
- Up to 2 computers per school. The photographer can reset this.
- Every exported PDF has the school's license code (e.g. `PP-7KQ4-M2XD`) in its file properties (Keywords and Creator). Staff can look up a code to see the school, admin, photographer and export count.
- A sign-in cookie copied into a different browser doesn't work.
- Each photographer is limited to 30 license sends or admin changes an hour (150 a day) and 20 link resends an hour. This protects the shared Dashboard@ email account and HubSpot.
- Nightly alert for more than 40 exports in a day (change with `PP_EXPORT_ALERT`), use from more than 3 internet connections in a day, repeated device-limit hits, or a photographer trying 5+ YearbookLife schools in a day.

**Known limit:** PDFs are built on the user's own computer, which is what keeps student data private. Someone technical could edit a saved copy of the page to skip the export check, and the same is true of the dashboard version today. The license stamp and usage alerts are the backstop. Closing this completely would mean building PDFs on the server, which would send student photos to us.

**Kept separate from the dashboard**
- Own accounts (Supabase tables `pp_*`, not Supabase Auth users, so the dashboard's invite and cleanup jobs never touch them), its own signing key (`PP_LICENSE_SECRET`), and its own on/off switch (`PP_ENABLED`).
- The only change to dashboard files is the word `export` on `PORTRAITPOP_HTML_B64` in `api/portraitpop.ts`, so both use the same copy of the tool. **When regenerating `api/portraitpop.ts`, keep that `export`.** If it's missing, only the photographer program stops (with a friendly message). The dashboard keeps working.

## One-time setup

1. **Database.** Supabase → your project → **SQL Editor** → **New query** → paste all of `supabase/portraitpop-licensing.sql` → **Run**. It's safe to run again.
2. **Signing key.** On your Mac press **⌘ Space**, type **Terminal**, press Return, paste `openssl rand -base64 48`, and press Return. Copy the line it prints.
3. **Vercel settings.** Vercel → **yearbooklife-portal** → **Settings** → **Environment Variables**. Add each of these for **Production** (and **Preview** if you'll test there):
   | Name | Value |
   |---|---|
   | `PP_LICENSE_SECRET` | the line from step 2 |
   | `PP_STAFF_EMAILS` | `heather@yearbooklife.com` (comma-separate to add more) |
   | `PP_ALERT_EMAIL` | `heather@yearbooklife.com` |
   | `PP_ENABLED` | `true` (or `false` to keep it closed until launch) |
   | `CRON_SECRET` | run the Terminal command again and use the new line (**required**: the nightly job won't run without it; Vercel sends it automatically) |
   | `PP_BASE_URL` | `https://yearbooklife-portal.vercel.app` (so emailed links always point at the live site) |

   It also uses settings that already exist: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HUBSPOT_ACCESS_TOKEN`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`.
4. **Deploy.** Merge the pull request. Vercel deploys on its own. (After you change environment variables, redeploy: **Deployments** → **⋯** on the latest → **Redeploy**.)
5. **Test run.**
   1. Go to `/pp`, enter your email, open the link, and click **Sign in**. You'll see the staff page.
   2. Add yourself as a test photographer using a different email you can read, then add 1 license.
   3. Sign in as that photographer in a private window (**⌘ Shift N** in Chrome). Send the license to a made-up school with a third email.
   4. Sign in as that admin and click **Open PortraitPop**. Confirm it exports.
   5. Try a real YearbookLife school and confirm it's blocked.
   6. Open the dashboard as a Canva customer and confirm PortraitPop still opens and exports as before.
   7. On the staff page, click **Preview tonight's check**.

**To switch the program off:** set `PP_ENABLED` to `false` and redeploy. The dashboard isn't affected.

## Files

`pp.html` · `api/pp-auth.ts` · `api/pp-photographer.ts` · `api/pp-staff.ts` · `api/pp-tool.ts` · `api/pp-verify.ts` · `api/pp-cron.ts` (nightly, 6 AM UTC) · `lib/pp.ts` · `supabase/portraitpop-licensing.sql`
