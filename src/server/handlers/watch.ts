// Filesystem watch tools: start watching a project dir, poll for accumulated
// change events, and stop a watcher. Pure handlers over the watcher module.

import { startWatch, pollWatch, stopWatch } from '../../watcher/index.js';
import type { HandlerMap } from '../registry.js';

export const watchHandlers: HandlerMap = {
  veto_watch: ({ args }) => {
    const dir = String(args?.project_dir ?? '').trim();
    if (!dir) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'project_dir is required.' }) }], isError: true };
    const watch_id = startWatch(dir);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, watch_id, project_dir: dir, message: `Watching "${dir}". Call veto_watch_poll with watch_id to collect events.` }, null, 2) }] };
  },

  veto_watch_poll: ({ args }) => {
    const watch_id = String(args?.watch_id ?? '').trim();
    if (!watch_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'watch_id is required.' }) }], isError: true };
    const result = pollWatch(watch_id);
    if (!result.found) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: `No active watcher with id: ${watch_id}` }) }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, watch_id, project_dir: result.project_dir, event_count: result.events.length, events: result.events }, null, 2) }] };
  },

  veto_watch_stop: ({ args }) => {
    const watch_id = String(args?.watch_id ?? '').trim();
    if (!watch_id) return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'watch_id is required.' }) }], isError: true };
    const stopped = stopWatch(watch_id);
    return { content: [{ type: 'text', text: JSON.stringify({ success: stopped, message: stopped ? `Watcher ${watch_id} stopped.` : `No watcher found with id: ${watch_id}` }, null, 2) }] };
  },
};
