// This file must not be deployed over the live ours-auth function.
// The existing project already authenticates with ours-auth and stores snapshots
// through ours_admin_upload_snapshot. Starting this entry would target a different schema.
throw new Error('Refusing to start ours-api. Use the deployed ours-auth function and the existing RPCs.');
