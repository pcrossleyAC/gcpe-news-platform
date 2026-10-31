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

A person's page has four parts: **Calendar access**, **Contact details**, **Comm contact** and **Account**. Changes to access and accounts reach the Calendar within a minute. Contact details and ranks take effect at once.

## Change their Calendar access

Choose **Edit Calendar access for** followed by their name. The choices and limits are the same as on [Calendar access](manual:calendar-admin-access). Where you can't change their access, the page says why instead.

## Contact details

1. Fill in **Phone** (up to 20 characters), **Mobile** (12 digits and hyphens, like 250-555-0100), **Job title** and **Description**. Leave any of them empty if you like.
2. Choose **Save contact details**. You see "Saved contact details."

The phone number shows under the person's name in the list's **Comm. Contact** column and in the Excel export.

## Comm-contact rank

A rank makes the person a comm contact for that ministry, so editors can choose them as an activity's **Comm Contact**. The page has one **Comm contact rank for** box for each of their ministries.

1. Choose a rank: **Comm Director**, **Comm Manager**, **Sr. PAO**, **PAO**, **Jr. PAO** or **Other**.
2. The rank saves as soon as you choose it. You see "Saved the comm-contact rank."

Choose **Not a comm contact** to stop offering them. Activities that already have them as comm contact keep them, but can't be cloned until they have an active comm contact.

"Give this user a ministry first." means they have no ministry yet. Give them one under **Calendar access**, wait a minute, then reload the page.

## Deactivate someone

Deactivating closes the person's Hub account. They can't sign in again until reactivated, and the Hub signs them out within 10 minutes.

1. Under **Account**, choose **Deactivate** followed by their name.
2. The page lists their **Open activities**: activities you can see where they are the comm contact, that aren't deleted and haven't ended. Only the first 500 are listed.
3. To hand those activities over first, choose **Transfer their activities first**. See [Transfer activities](manual:calendar-transfer).
4. Choose **Deactivate**, or **Deactivate anyway** when activities are listed. You see that the person "is deactivated. The Calendar picks this up within a minute."

Deactivating doesn't move their activities. Each one keeps them as comm contact and can still be saved, but can't be cloned until it has an active comm contact. Editors can't choose them as a comm contact any more.

Nobody is emailed, including the person.

The list of open activities leaves out any activity where you set them to **Not a comm contact** first. Check **Transfer** for those.

## Reactivate someone

Choose **Reactivate** followed by their name. You see that the person "is reactivated. The Calendar picks this up within a minute." Their ranks come back as they were.

## Link someone with no email

People brought in from the old Calendar without an email show "No email — inactive". Their page says "This user was imported without an email. Linking sets their email and activates them."

1. Enter their work address in **Email**.
2. Choose **Link and activate**. You see that the person "is linked and active. The Calendar picks this up within a minute."

They can then sign in with Microsoft using that address.

## Who you can deactivate, reactivate or link

Only people who use nothing in the Hub but the Calendar, and whose Calendar access you could change. You can't deactivate yourself, so the button isn't shown on your own page.

The page offers the button for other people too, then refuses when you confirm:

| Message | What it means |
|---|---|
| "only a Core admin can change a user who also has NRMS or NoD roles" | The person also works in Releases or Subscribers. Ask a Core administrator. |
| "only a Core admin can change a user who has no Calendar role" | The person has no Calendar role. Ask a Core administrator. |
| "only an HQ Administrator, a System Administrator or a Core admin can change the Calendar access of someone with an HQ ministry" | The person belongs to an HQ organization and you don't. |
| "only a System Administrator or a Core admin can change a System Administrator's access" | The person is a system administrator and you are an Administrator. |
| "a user with that email already exists" | Another Hub account has that address. Ask a Core administrator. |

## Can't do this?

| Message | What it means |
|---|---|
| "at most 20 characters" | Shorten the phone number. |
| "use 12 digits and hyphens, like 250-555-0100" | Fix the mobile number, or leave it empty. |
| "job title: at most 100 characters" | Shorten the job title. |
| "description: at most 2000 characters" | Shorten the description. |
| "health isn't one of this user's ministries in the Calendar yet: save their ministries first; the Calendar picks them up within a minute" | The ministry (shown by its short web name) was only just given. Wait a minute, reload, and choose the rank again. |
| "This user isn't in the Calendar." | The address you opened isn't a Calendar user. Go back to **All Calendar users**. |
