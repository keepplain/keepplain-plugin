/** Query-time repository scope and proven client identity; never infer an id from the newest file. */
export const MEMORY_TOOLS = ['search_my_work', 'get_task_context', 'get_session_excerpt', 'attach_session_to_task'];
export function workContext(agent, project, env = process.env, explicitSession = null) {
    const ids = { 'claude-code': env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID, codex: env.CODEX_THREAD_ID, pi: env.PI_SESSION_ID, antigravity: env.ANTIGRAVITY_CONVERSATION_ID };
    if (explicitSession && ids[agent] && explicitSession !== ids[agent]) throw new Error('The supplied id is not the current session.');
    const session = ids[agent] || explicitSession || null;
    return { project_key: project?.key ?? null, client: ({'claude-code':'claude_plugin',codex:'codex_plugin',pi:'pi_plugin',cursor:'cursor_plugin',antigravity:'antigravity_plugin'})[agent], session_id: /^[A-Za-z0-9_.:-]{1,100}$/.test(session ?? '') ? session : null };
}
export function memoryArguments(tool, params, context) {
    if (tool === 'search_my_work' && params.scope !== 'all' && !params.project_id && !params.project_key && context.project_key) return {...params, project_key: context.project_key};
    if (tool === 'attach_session_to_task') {
        const session = context.session_id || params.session_id;
        if (!session || !/^[A-Za-z0-9_.:-]{1,100}$/.test(session)) throw new Error('The actual current session id is required. Do not select the newest session file.');
        if (context.session_id && params.session_id && params.session_id !== context.session_id) throw new Error('The supplied id is not the current session.');
        if (params.client && params.client !== context.client) throw new Error('The supplied client is not the current agent.');
        return {...params, client: context.client, session_id: session};
    }
    return params;
}
