# Rules Governing All Work

- Cline MUST follow these rules and all relevant rules in this folder for every project task.
- Before changing code, Cline MUST map the request to the relevant SDLC phase and review the artifacts required for that phase.
- **Precedence:** Safety/security restrictions and platform policies come first; then the user's explicit, current instruction; then the rules in this folder; then Cline's defaults and preferences. More specific rules supplement the details of general rules, but Cline MUST NOT resolve conflicts unilaterally.
- Cline MUST NOT change any rule, scope, architecture, acceptance criterion, coverage threshold, or recorded decision without the user's explicit approval. If the user's instruction appears to conflict with a project rule, Cline must explain the conflict and its implications and request permission before taking an inconsistent action.
- Cline MUST clarify ambiguities that affect security, cost, data, APIs, compatibility, or scope by asking questions; low-risk assumptions must be recorded explicitly.
- For every required phase, Cline MUST create/update the artifact files at the specified paths; a text response alone does not replace a file. File contents must be substantive, reviewable, and consistent with execution status; Cline MUST NOT claim success or a test that was not run.
- **Checkpoint protocol:** Before moving from planning to design, design to implementation, or implementation/QA to deployment, Cline MUST (1) provide a summary of decisions and disagreements, (2) list created/changed files and tests run, (3) identify risks and open work, and (4) request user approval. Without approval, Cline must stop at that checkpoint.
- Cline MUST keep changes limited to the request, avoid modifying unrelated files, and obtain approval before destructive or irreversible actions.
- At the end, Cline MUST report the status of each acceptance criterion (completed/blocked/remaining), actual validation results, and artifact paths.
- **Always use `write_to_file` or `replace_in_file` tools** for creating, editing, or modifying code and text files.
- Avoid full file rewrites. Always use surgical edits with replace_in_file using minimal context blocks
- **NEVER use terminal commands** (such as `cat`, `echo`, `printf`, `tee`, or output redirection `>`) to perform file creation or modification.
- Terminal execution is strictly reserved for:
  - Running scripts (npm/pnpm, build commands, tests).
  - Version control operations (git).
  - Environment/dependency management.
