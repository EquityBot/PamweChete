---
description: Verify the current work without assuming it is correct
argument-hint: "[scope or acceptance criteria]"
---
Verify the current implementation against ${ARGUMENTS:-the repository's documented requirements and the user's request}.

Stay read-only unless the user also asked for fixes. Read the applicable instructions and exact repository-defined commands, inspect the diff and relevant implementation, then run the narrowest meaningful tests before broader checks. Treat warnings, skipped checks, and untested branches explicitly.

Report the verdict first. Then list concrete evidence, defects or risks with file locations, and every required check that was not run. Do not repeat an unchanged failed command or claim success from source inspection alone.
