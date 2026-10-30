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

**Operations** stops and starts outgoing email, sets who gets the daily bounce summary, and controls the retention purge. Only Subscribers administrators see it.

## Pause News On Demand sending

Pause this to hold news email, for example during an election period or while a problem is fixed.

1. Under **News On Demand sending**, choose **Pause News On Demand sending**. The Hub asks "Pause News On Demand sending?" and explains "News On Demand keeps recording releases and building emails but holds them until you resume. Nothing is dropped. The operations inbox is emailed."
2. Choose **Confirm pause**. You see "News On Demand sending paused." and the section shows **Paused**.

While paused, no as-it-happens, digest, emergency alert or media list email leaves News On Demand. Confirmation emails to people signing up still go out.

To resume, choose **Resume News On Demand sending**, then **Confirm resume**. "Held emails start going out straight away."

## Pause Distribution

Distribution is the service that sends email for every app. Pause it only when email from all of them must stop.

1. Under **Distribution**, choose **Pause Distribution**. The Hub asks "Pause Distribution?" and explains "No email goes out from any app, except system notices, until you resume. Queued email is kept. The operations inbox is emailed."
2. Choose **Confirm pause**. You see "Distribution paused."

System notices still go out while paused. These include sign-up confirmations, manage-subscription links, the bounce summary and the pause emails themselves.

To resume, choose **Resume Distribution**, then **Confirm resume**. "Queued email starts going out straight away."

## Before you resume after a long pause

Everything held goes out when you resume, however old it is. After a long pause, decide first whether old releases should still be sent. An email held more than 24 hours that then fails to send is not tried again.

## Who is told

Each pause and resume emails the operations inbox with your name and the time. If this site has no operations inbox, nobody is emailed. Subscribers are never told.

## Bounce summary

The bounce summary is a daily email at 8:00 am listing bounced subscribers. It is sent only when there were bounces. See [Bounces](manual:bounces) for what it contains.

The section shows where it goes now:

- "Using the server default: {address}" means no one has chosen an address here, so the site's own address is used. The box is empty on purpose.
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

- people who signed up but never confirmed, after 10 days;
- unused sign-up links, after 10 days;
- people who unsubscribed or were deleted more than 90 days ago, with their history and delivery records.

It never deletes subscribers disabled by bounces. When it deletes someone who had left a media list by unsubscribing, it keeps that they left the list, without their address, so adding that address back still asks first.

**If it ran now, it would delete** shows the counts before you turn it on.

1. Choose **Turn on the retention purge**. The Hub asks "Turn on the retention purge?" and says how many subscribers and links the next run deletes "for good, and keeps doing so every night. This can't be undone."
2. Choose **Turn on purge**. You see "Retention purge turned on."

Deleted records can't be brought back. To stop it, choose **Turn off the retention purge**, then **Turn off purge**. Nothing more is deleted.

Links in sent emails are cleared every night 10 days after they expire, whether the purge is on or off. They stopped working long before.

People brought over from the old News On Demand who had already left are kept for 90 days from the move, whatever their old end date.

## Test bounce upload

This section shows on test sites only, where every email is redirected and real bounces never arrive.

1. Choose a bounce message file under **Bounce message (.eml)**, or paste it in **Or paste the message**.
2. Choose **Upload bounce**. You see "Uploaded. Bounce processing picks it up within 15 minutes."

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
