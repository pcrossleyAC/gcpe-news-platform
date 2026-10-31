# UX review checklist (staff Hub)

Use this checklist for every UX review of the staff Hub (`apps/staff-web`), whether it covers the whole Hub, one area, or a re-score after polish work. Each part has its own check. A review that skips a part says so in its report.

## Ground rules

- **Parity in functionality, not in the nonsensical.** Copying what the old system did is not a reason to keep something confusing. That covers section order, wording and dead ends as much as anything else. If a reasonable person new to the Hub would trip over it, it's a finding, even when legacy did the same.
- **Look and feel vs behaviour.**
  - Look-and-feel fixes are fixed without waiting: layout, order, grouping, wording, hints, focus.
  - Behaviour changes go to the owner as a decision, with a recommendation. A behaviour change is anything that changes what is saved, sent or published, adds or removes a confirmation, or changes who can act.
- **Review as each role.** A screen seen only as an admin hasn't been reviewed. Sign in to the review Hub as each role that uses the screen:
  - Core admin;
  - NRMS Site editor, Editor and Viewer;
  - NoD Admin, Editor and Viewer;
  - Calendar System administrator, Administrator, Advanced, Editor and Read-only, both in a ministry and in HQ where it matters.

## 1. Task walkthroughs from a blank start (required)

Screenshots and heuristic scores miss problems that only show when someone fills a form in. For every main task, start from nothing and do the whole task as someone new would.

The main tasks are:
- create a release, approve it, schedule it, publish it, correct it and unpublish it;
- add a Calendar activity;
- add a subscriber and change their lists;
- add a reporter to a media list;
- change a site setting and publish it;
- add and edit an organization;
- give someone a Calendar role and make them a comm contact;
- start a government term.

For each one:
- [ ] Use a **new, empty** item, not seeded data. Empty states, "choose X first" messages and required markers only show up then.
- [ ] Work down the page in order. Nothing should depend on a field, section or tab further down. Example: a "Choose the lead ministry first" message whose Lead Ministry field sits two sections lower.
- [ ] Every instruction names a control that is really there, by its on-screen label.
- [ ] Things filled in together sit together, such as a start and end date, or a checkbox and the fields it turns on.
- [ ] Required markers and defaults make sense for the role and the state. Nothing is marked required on a read-only view, and no required field hides until something else is chosen without saying so.
- [ ] Every button that is shown can do something in this state, or says plainly why it can't.
- [ ] The task ends with a clear result: where you land, what message you see, and what happened elsewhere (emails, the public site).
- [ ] Repeat the task as the lowest role that can do it, then as a role that can't. The second role should see a plain explanation, not a dead end.

## 2. Heuristic score

- [ ] Score the 10 usability heuristics from 1 to 4 each, out of 40, with evidence (file:line or a screenshot) for every score below 4.
- [ ] Give each finding a priority: P0 blocks the task, P1 is likely to cause a mistake, P2 slows people down, P3 is polish.
- [ ] Note the assessor and the method, so re-scores can be compared. A different assessor isn't a strict before and after.

## 3. Automated checks

- [ ] Run axe on every screen state reviewed, at 1440, 1024 and 390 px. Aim for 0 serious or critical violations, and list anything left to check by hand.
- [ ] Check for sideways page scroll at 390 px. Wide tables scroll inside their own box.
- [ ] Check the console for errors and failed requests for each role. For example, a role that can't use an area shouldn't trigger 403s from it.
- [ ] Run the design detector, if the review uses it, and judge each finding as real or a false positive.

## 4. Help and manuals

- [ ] For each screen and role, the header **Help** opens a manual page about that screen that the reader can see. `apps/staff-web/src/manuals/help-target.test.ts` pins this. Add cases for new screens.
- [ ] Help's **How do I…** shows only tasks the reader's role can do.
- [ ] The manual pages for the screen still match what's on it. If a fix changes a screen, update its manual page in the same change; the CI manuals check enforces this.

## 5. Report

Write the report with these sections, in this order:
- [ ] Findings ranked by priority, each marked **look and feel** or **behaviour**.
- [ ] The look-and-feel fixes made, with before and after screenshots.
- [ ] Owner decisions, each with a one-line recommendation.
- [ ] Anything not checked, and why.
