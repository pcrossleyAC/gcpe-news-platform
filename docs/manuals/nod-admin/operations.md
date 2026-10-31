---
id: subscriber-operations
title: Operations
manual: nod-admin
order: 60
routes: [/subscribers/operations]
screens: [subscribers]
topics: []
---
**Who this is for:** Subscribers administrators (NoD.Admin).

**Operations** stops and starts outgoing email, shows news email that is held or failed, sets who gets the daily bounce summary, and controls the retention purge. Only Subscribers administrators see it.

## Pause News On Demand sending

Pause this to hold news email, for example during an election period or while a problem is fixed.

1. Under **News On Demand sending**, choose **Pause News On Demand sending**. The Hub asks "Pause News On Demand sending?" and explains "News On Demand keeps recording releases and building emails but holds them until you resume. Nothing is dropped." and says who is emailed about it.
2. Choose **Confirm pause**. You see "News On Demand sending paused." and the section shows **Paused**.

While paused, no as-it-happens, digest, emergency alert or media list email leaves News On Demand. Confirmation emails to people signing up still go out.

To resume:

1. Choose **Resume News On Demand sending**. The Hub asks "Resume News On Demand sending?" and says how much goes out straight away, counted as you open the question, for example "1,205 held emails for 3 releases start going out straight away. The oldest has waited 12 days, since …". When nothing is held, it says "Nothing is held, so nothing goes out straight away."
2. Choose **Confirm resume**. You see how much was actually released, for example "News On Demand sending resumed. 1,205 held emails for 3 releases are going out now." To cancel some held email first, choose **Cancel** instead and use **Outgoing news email**, below.

## Pause Distribution

Distribution is the service that sends email for every app. Pause it only when email from all of them must stop.

1. Under **Distribution**, choose **Pause Distribution**. The Hub asks "Pause Distribution?" and explains "No email goes out from any app, except system notices, until you resume. Queued email is kept." and says who is emailed about it.
2. Choose **Confirm pause**. You see "Distribution paused."

System notices still go out while paused. These include sign-up confirmations, manage-subscription links, the bounce summary and the pause emails themselves.

To resume, choose **Resume Distribution**, then **Confirm resume**. The Hub warns that queued email starts going out straight away.

## Outgoing news email

This section shows news email that hasn't gone out yet, and news email that failed.

While News On Demand sending is paused, it says how much is held, for example "Held while paused: 1,205 emails for 3 releases. The oldest has waited 12 days, since …". The **Held news email** table has one row per release and type: **As it happens**, **Media list**, **Emergency alert**, or **Daily digest** (one row per daily digest, with how many releases it carries). **Emails** counts the active subscribers it would still go to, leaving out anyone an earlier try already reached. **Note** shows when an email has already been tried and what went wrong.

While sending is running, the section normally says "Nothing is waiting to go out." Anything listed is waiting to be tried again.

### Before you resume after a long pause

Everything held goes out when you resume, however old it is. After a long pause, decide first whether old releases should still be sent, and cancel the ones that shouldn't:

1. Choose **Cancel** on a release's row, or **Cancel all held email**.
2. The Hub asks "Cancel held email?", says how many emails for how many releases won't be sent, and lists each one. If emergency alerts are among them, it adds, for example, "This includes 1 emergency alert."
3. Choose **Cancel held email**. You see, for example, "Cancelled 1,200 held emails." If some had already started going out just before the pause, the message adds "Some had already started going out, so they weren’t cancelled." To keep them, choose **Keep it**.

Each cancel is recorded with your name and the releases and daily digests it cancelled.

Cancelled email is never sent, and this can't be undone. If an editor later unpublishes the release and publishes it again, it is emailed again as a new release. On **Sends per release**, cancelled as-it-happens and media list emails count as **Not sent**; a cancelled daily digest is left out of **Daily digest runs**. You can cancel only while News On Demand sending is paused. If someone resumed it meanwhile, you see "News On Demand sending isn’t paused, so nothing was cancelled. Pause it first."

### Failed in the last 30 days

News email that Distribution refused, or that kept failing for 24 hours, is listed under **Failed in the last 30 days** with how many emails weren't sent and what went wrong. An email held more than 24 hours that then fails to send is not tried again. Failed email isn't sent again by itself: ask technical support to look at the error. When nothing failed, you see "No news email failed in the last 30 days."

## Who is told

Each pause and resume emails the operations inbox with your name and the time, and the question says "The operations inbox is emailed." If this site has no operations inbox, nobody is emailed, and the question says "No one is emailed about it." Subscribers are never told.

## Bounce summary

The bounce summary is a daily email at 8:00 am listing bounced subscribers. It is sent only when there were bounces. See [Bounces](manual:bounces) for what it contains.

The section shows where it goes now:

- "Using the server default:" followed by an address means no one has chosen an address here, so the site's own address is used. The box is empty on purpose.
- "No address is set, so no summary is sent." means nobody gets it.

To send it somewhere else:

1. Enter the address in **Bounce summary email**.
2. Choose **Save address**. You see "Bounce summary address saved."

To go back to the site's own address, choose **Use the server default**. You see "Using the server default again." Saving the box empty does the same.

## Soft bounces counted as hard

A soft bounce is a temporary failure, such as a full mailbox. Its code starts with 4. Soft bounces never count toward disabling a subscriber, except the codes you list here. Those count like a hard bounce from the next bounce on, never for earlier ones.

1. Enter codes in **Soft codes counted as hard**, such as 4.2.2, separated by commas.
2. Choose **Save codes**. You see "Soft bounce codes saved."

Leave the box empty to count none.

## Emergency alerts feed

This section shows when the Emergency Info BC feed was last checked and how many alerts were new. Nothing here can be changed. A warning means the last check failed; it tries again every 5 minutes by itself.

The first time a feed is read, its alerts are recorded without emailing anyone. Only alerts posted after that are sent.

## Retention purge

The retention purge permanently deletes old personal information. Leave it **Off** until the business has set retention rules.

When on, every night at 3:00 am it deletes:

- sign-ups that were never confirmed, after 10 days;
- people who unsubscribed or were deleted more than 90 days ago, with their history and delivery records.

It never deletes subscribers disabled by bounces. When it deletes someone who had left a media list, it keeps that they left the list, without their address, so adding that address back still asks first.

**If it ran now, it would delete** shows the counts before you turn it on. While it is on, the section also shows how its last run went. While it is off, no last run is shown.

1. Choose **Turn on the retention purge**. The Hub asks "Turn on the retention purge?" and says how many subscribers and links the next run deletes "for good, and keeps doing so every night. This can't be undone."
2. Choose **Turn on purge**. You see "Retention purge turned on."

Deleted records can't be brought back. To stop it, choose **Turn off the retention purge**, then **Turn off purge**. Nothing more is deleted.

Links in sent emails are cleared every night 10 days after they expire, whether the purge is on or off. They stopped working long before.

Records imported from the old system that had already ended are kept until 90 days after the import.

## Test bounce upload

This section shows on test sites only, where every email is redirected and real bounces never arrive.

1. Choose a bounce message file under **Bounce message (.eml)**, or paste it in **Or paste the message**.
2. Choose **Upload bounce**. You see "Uploaded. Bounce processing picks it up within 15 minutes."

## If you leave before saving

If you have changes you haven't saved and you go to another screen or choose your browser's **Back**, the Hub asks "You have unsaved changes on this page. Leave anyway and discard them?" Choose **Stay** to keep working, or **Leave** to discard the changes. Closing or reloading the tab gets your browser's own question.

## Can't do this?

| Message | What it means |
|---|---|
| "Distribution isn't responding. Nothing changed." | Distribution is down. Try again shortly. |
| "Distribution isn't responding, so its state is unknown. Reload the page shortly." | The Hub can't tell whether Distribution is paused. |
| "Couldn't change it. Nothing changed." | The change didn't save. Try again. |
| "Enter a valid email address." | Check the bounce summary address. |
| "Enter codes like 4.2.2, separated by commas." | Only codes starting with 4 can be listed. |
| "Couldn't save. Try again." | The setting didn't save. |
| "Choose a .eml file or paste a message first." | Add a bounce message before uploading. |
| "That file is over 1 MB." | Bounce messages can be up to 1 MB. |
| "This site doesn't use the test mailbox." | Bounces on this site come from the real mailbox. |
