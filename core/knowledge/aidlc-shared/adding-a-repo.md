# Adding a Repo to the Work

> **Audience**: the architect, developer and product agents, and any agent
> that finds mid-work that the change needs another repo.
> **Owner of this file**: framework. A team's own how goes in
> `aidlc/knowledge/aidlc-shared/` (see section 5).

A piece of work that records repos (several repos beside one `aidlc/`) covers
the repos it was created with. When the change needs another, it joins the
work through one command, at any stage.

---

## 1. When a repo joins

- **The change will modify it**: it joins. Code Generation will write there, a
  contract changes there, a migration runs there.
- **You only read it** (to learn an API, a schema, a convention): it does not
  join. Read it where it is.

## 2. The command

```
{{INVOKE}} engine intent add-repo <name> --reason '<why this work changes it>'
```

- `<name>` is the repo's folder name beside the other repos.
- A repo that is not cloned here yet is cloned first: from its `repos.json`
  entry, else from the team's `repos.json` `org`. The tool uses the person's
  own git setup, writes the `repos.json` entry, and refreshes the managed
  `.gitignore` block and `aidlc.code-workspace`.
- Never pass `--url` yourself: a name taken from a search result must resolve
  inside the team's org. An address comes from the person. When they give one,
  pass it with `--url <address>`, and pass their words with
  `--person-words '<their words>'` instead of `--reason`.
- Say the line the tool prints, once. It says what happened and the way back
  (`intent remove-repo <name>`, which leaves the folder and its `repos.json`
  line in place).

## 3. After Units Generation is approved

The add lands at any stage. What it means for the approved Units follows the
work's Guard Policy:

- **strict**: the next `next` asks the person once whether the Units still
  stand, or whether to go back to Units Generation. Show the question as given
  and act on their reply.
- **relaxed** or **off**: the work carries on with the approved Units; the
  tool's line says so, with the way back to Units Generation.

A Unit that will change the new repo names it in its Code Generation plan's
source manifest, which the person approves where plan approval is on. Reverse
Engineering shows as behind for the new repo until it is revisited.

## 4. When the clone does not land

- **The clone failed**: the line carries git's own reason and the `git clone`
  command to run by hand, and nothing was recorded. Give the person both; once
  the repo is cloned, run the same add again.
- **The host cut the command off** (a command timeout in the host tool): run the
  same add again with a longer timeout where the host allows one; otherwise
  give the person the `git clone -- <address> "<workspace>/<name>"` command, then
  add the repo once it is there. A leftover `.aidlc-workspace-sync-txn-*`
  folder in the workspace is ignored by the managed `.gitignore` block and can
  be deleted.
- **No address** (no `repos.json` org and no `--url`): ask the person for the
  repo's clone address.

## 5. A team's own how

- What counts as needed, and where to look it up (the team's code index or code
  search), goes in `aidlc/knowledge/aidlc-shared/`.
- A team that wants to be asked before any repo joins writes one line under
  `## Mandated` in `aidlc/spaces/<active-space>/memory/team.md` or
  `project.md`, which the agents read with the rest of the space's memory.
