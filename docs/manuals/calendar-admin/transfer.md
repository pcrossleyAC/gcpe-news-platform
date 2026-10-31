---
id: calendar-transfer
title: Transfer activities
manual: calendar-admin
order: 30
routes: [/calendar/transfer]
screens: [calendar/transfer]
topics: []
---
**Who this is for:** Calendar administrators (Calendar.Administrator) and Calendar system administrators (Calendar.SysAdmin).

**Calendar** > **Transfer** moves every activity of one comm contact to another, past ones included. Use it when someone leaves or changes jobs. Deleted activities stay where they are.

## Move the activities

1. Choose **From comm contact**. Contacts who are no longer active, or whose account is inactive, are marked "— inactive". If you came from **Transfer their activities first** on a user's page, that person is already chosen when they are a comm contact for one ministry.
2. Choose **To comm contact**. Only active contacts whose ministry can lead an activity are offered.
3. Choose **Preview**. You see how many will move, such as "4 activities will move from Robin Example (HLTH) to Sam Example (FIN). Their lead ministry becomes Finance."
4. Choose **Transfer 4 activities** (the button names the count). You see "Transferred 4 activities from Robin Example (HLTH) to Sam Example (FIN)."

Nothing asks you again: the preview is your check. Changing either list clears the preview.

## Which activities move

- **HQ Administrators**: both lists show every ministry's comm contacts. Every activity of the first contact moves.
- **Other administrators, system administrators included**: both lists show only your own ministries' comm contacts. Only activities led by the first contact's ministry move. An activity another ministry leads and only shares with yours stays where it is.

## What changes on each activity

- Its **Comm Contact** becomes the new contact, and its **Lead Ministry** becomes the new contact's ministry.
- When the lead ministry changes, the old ministry's staff can no longer change the activity. They no longer see it at all unless it is shared with their ministry.
- Its status, its review marks and its "updated" time don't change. HQ is not asked to review it again.
- Its **View changes** records that you transferred it, with the old and new comm contact and lead ministry. Transfers don't appear on **Updates**.
- Anyone editing one of these activities at the time is told someone else changed it when they save, and must reload.
- Transfer works during the daily change freeze.
- Nobody is emailed.

## Can't do this?

| Message | What it means |
|---|---|
| "Choose two different comm contacts" | From and To are the same contact. |
| "Choose an active comm contact to transfer to" | The To contact was made inactive. Choose another. |
| "That person's account is inactive" | The To person was deactivated. Choose another. |
| "That ministry is no longer active" | The To contact's ministry was deactivated. |
| "That ministry can't lead an activity" | The To contact's ministry can't lead activities. Choose a contact in another ministry. |
| "That comm contact is no longer available: reload the page." | A contact changed since the page loaded. Reload and choose again. |
| "Only 100 activities moved from … before a later batch failed. Preview again and try the rest." | Some activities moved and the rest didn't. Choose **Preview** again to see what is left, then transfer again. |
