// Loaded by Bun before a plugin's script when AI-DLC starts it with the aidlc
// binary as Bun (aidlc-plugin-script.ts). BUN_BE_BUN only had to reach that
// start; taken out here, an `aidlc` the script runs is the engine again.
delete process.env.BUN_BE_BUN;
