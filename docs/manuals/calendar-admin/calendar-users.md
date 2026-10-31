---
id: calendar-users
title: Calendar users
manual: calendar-admin
order: 20
routes: [/calendar/users]
screens: [calendar/users]
topics: []
---
**Who this is for:** Calendar administrators (Calendar.Administrator) and Calendar system administrators (Calendar.SysAdmin).

**Calendar** > **Users** lists everyone with Calendar access, one row for each of their ministries: **Name**, **Ministry**, **Comm contact**, **Calendar role** and **Active**.

- Type a name or a ministry abbreviation in **Find by name or ministry** to narrow the list.
- Tick **Show inactive users, including those with no email** or **Show users without Calendar access** to see more people.
- Choose a name to open that person's page.

If two old Calendar accounts had the same email address, they are now one user.

A person's page has four parts: **Calendar access**, **Contact details**, **Comm contact** and **Account**. Changes to access and accounts reach the Calendar within a minute. Contact details and ranks take effect at once.

## Change their Calendar access

Choose **Edit Calendar access for** followed by their name. The choices and limits are the same as on [Calendar access](manual:calendar-admin-access). Where you can't change their access, the page says why instead.

## Contact details

1. Fill in **Phone** (up to 20 characters), **Mobile** (12 digits and hyphens, like 250-555-0100), **Job title** and **Description**. Leave any of them empty if you like.
2. Choose **Save contact details**. You see "Saved contact details."

The phone number shows under the person's name in the list's **Comm Contact** column and in the Excel export.

## Comm-contact rank

A rank makes the person a comm contact for that ministry, so editors can choose them as an activity's **Comm Contact**. The page has one **Comm contact rank for** box for each of their ministries.

1. Choose a rank: **Comm Director**, **Comm Manager**, **Sr. PAO**, **PAO**, **Jr. PAO** or **Other**.
2. The rank saves as soon as you choose it. Beside the box you see, for example, "Saved: Comm Director for Health (HLTH)." If it doesn't save, the same place says why, such as "The rank wasn't saved. Try again."

Choose **Not a comm contact** to stop offering them. Activities that already have them as comm contact keep them, but can't be cloned until they have an active comm contact.

"Give this user a ministry under Calendar access (Edit Calendar access) first." means they have no ministry yet. Choose **Edit Calendar access** above and give them one.

Just after you give someone a ministry, or take one away, the page says "Updating their ministries in the Calendar… This page catches up by itself in a moment." Stay on the page: the rank boxes follow by themselves, usually within a minute. If they haven't after about a minute and a half, the page says "The Calendar hasn't picked up their ministry changes yet. Reload the page in a minute."

## Deactivate someone

Deactivating closes the person's Hub account. They can't sign in again until reactivated, and the Hub signs them out within 10 minutes.

1. Under **Account**, choose **Deactivate** followed by their name.
2. The page lists their **Open activities**: activities you can see where they are the comm contact, that aren't deleted and haven't ended, even if you set them to **Not a comm contact**. Only the first 500 are listed.
3. If they also work for ministries you don't belong to, the page says "They also work for ministries you don't belong to. Ask an HQ Administrator to check and transfer their activities there." You can't see their activities in those ministries, so the page doesn't say whether there are any. With none listed, it says "No open activities in your ministries." instead of "No open activities."
4. To hand the listed activities over first, choose **Transfer their activities first**. **Transfer** opens with them already chosen as **From comm contact** when they are a comm contact for one ministry; for several, choose which. See [Transfer activities](manual:calendar-transfer).
5. Choose **Deactivate**, or **Deactivate anyway** when activities are listed. You see that the person "is deactivated. The Calendar picks this up within a minute."

Deactivating doesn't move their activities. Each one keeps them as comm contact and can still be saved, but can't be cloned until it has an active comm contact. Editors can't choose them as a comm contact any more.

Nobody is emailed, including the person.

## Reactivate someone

Choose **Reactivate** followed by their name. You see that the person "is reactivated. The Calendar picks this up within a minute." Their ranks come back as they were.

## Link someone with no email

People brought in from the old Calendar without an email show "No email — inactive". Their page says "This user was imported without an email. Linking sets their email and activates them."

1. Enter their work address in **Email**.
2. Choose **Link and activate**. You see that the person "is linked and active. The Calendar picks this up within a minute."

They can then sign in with Microsoft using that address.

## Who you can deactivate, reactivate or link

Only people who use nothing in the Hub but the Calendar, and whose Calendar access you could change. You can't deactivate yourself, so the button isn't shown on your own page.

For anyone else you can't change, **Account** says why instead of showing the button. The message names the button it replaces: deactivate, reactivate or link.

| Message | What it means |
|---|---|
| "Only a Core administrator can deactivate someone who also has other Hub roles." | The person also works in Releases or Subscribers. Ask a Core administrator. |
| "Only a Core administrator can reactivate someone who has no Calendar role." | The person has no Calendar role. Ask a Core administrator. |
| "Only an HQ Administrator, a System Administrator or a Core administrator can deactivate someone in an HQ organization." | The person belongs to an HQ organization and you don't. |
| "Only a System Administrator or a Core administrator can deactivate a System Administrator." | The person is a system administrator and you are an Administrator. |

If the person's access changed a moment ago, the same message can appear after you choose the button instead.

## Can't do this?

| Message | What it means |
|---|---|
| "at most 20 characters" | Shorten the phone number. |
| "use 12 digits and hyphens, like 250-555-0100" | Fix the mobile number, or leave it empty. |
| "job title: at most 100 characters" | Shorten the job title. |
| "description: at most 2000 characters" | Shorten the description. |
| "Health isn't one of this user's ministries in the Calendar yet. Save their ministries first." | That ministry was only just given, or taken away, in another window. Reload the page, and choose the rank again once its box appears. |
| "A user with that email already exists." | When linking: another Hub account has that address. Ask a Core administrator. |
| "This user isn't in the Calendar." | The address you opened isn't a Calendar user. Go back to **All Calendar users**. |
