import { app } from '@azure/functions';
import { pollUsage } from '../lib/usagePoll.js';

app.timer('hereUsage', {
  schedule: '0 7 * * * *',
  runOnStartup: false,
  handler: (_timer, context) => pollUsage(context),
});
