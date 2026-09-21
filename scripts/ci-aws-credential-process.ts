/** AWS credential_process Version 1 response; never persists the credentials. */
export function credentialProcessResponse(env: NodeJS.ProcessEnv): {
  Version: 1;
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
} {
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const) {
    if (!env[key]) throw new Error(`Missing required credential environment variable: ${key}`);
  }
  return {
    Version: 1,
    AccessKeyId: env.AWS_ACCESS_KEY_ID!,
    SecretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    SessionToken: env.AWS_SESSION_TOKEN!,
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(credentialProcessResponse(process.env)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
