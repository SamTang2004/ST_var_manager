// ============================================================================
// == Situational Awareness Manager
// == Version: 1.5
// ==
// == This script provides a robust state management system for SillyTavern.
// == It correctly maintains a nested state object and passes it to the UI
// == functions, ensuring proper variable display and structure.
// ============================================================================f

(function () {
    // --- CONFIGURATION ---
    const SCRIPT_NAME = "Situational Awareness Manager";
    const STATE_BLOCK_START_MARKER = '<!--<|state|>';
    const STATE_BLOCK_END_MARKER = '</|state|>-->';

    // NON-GREEDY (lazy): Used for PARSING a single, valid state block. Note the `*?`.
    const STATE_BLOCK_PARSE_REGEX = new RegExp(`${STATE_BLOCK_START_MARKER.replace(/\|/g, '\\|')}([\\s\\S]*?)${STATE_BLOCK_END_MARKER.replace(/\|/g, '\\|')}`, 's');

    // GREEDY: Used for REMOVING all state blocks, from the first start to the last end. Note the `*`.
    const STATE_BLOCK_REMOVE_REGEX = new RegExp(`${STATE_BLOCK_START_MARKER.replace(/\|/g, '\\|')}([\\s\\S]*)${STATE_BLOCK_END_MARKER.replace(/\|/g, '\\|')}`, 's');

    // Use a global flag for the regex to find all commands in one go.
    const COMMAND_REGEX = /<(?<type>SET|ADD|TIMED_SET|RESPONSE_SUMMARY|CANCEL_SET)\s*::\s*(?<params>[\s\S]*?)>/g;
    const INITIAL_STATE = { static: {}, volatile: [], responseSummary: [] };


    // handle 3 cases of generation failures.
    // case 1: generation begin -> failed -> no new message is born -> shouldn't require special treatment IFF user does not double press.
    // -> upon generation begin, update latest_gen_lvl to correct value (this value) and see if the new received value is > this value. If so them proc, if not, do not proc.

    // case 2: generation begin -> failed -> new message is born -> parsed -> no command and no json -> json appended -> game continues -> treat as normal
    // case 3: generation begin -> generation interrupted -> treat as case 2
    var latest_gen_lvl = -1;

    // --- HELPER FUNCTIONS ---
    // TODO: refactor getchatmessages to JS-slash-runner version
    // TODO: refactor updates
    

    async function getRoundCounter(){

        return await getChatMessages("{{lastMessageId}}").message_id;
    }



    function parseStateFromMessage(messageContent) {
        if (!messageContent) return null;
        const match = messageContent.match(STATE_BLOCK_PARSE_REGEX);
        if (match && match[1]) {
            try {
                return JSON.parse(match[1].trim());
            } catch (error) {
                console.error(`[${SCRIPT_NAME}] Failed to parse state JSON.`, error);
                return null;
            }
        }
        return null;
    }

    async function findLatestState(chatHistory) {
        for (let i = chatHistory.length - 1; i >= 0; i--) {

            //console.log(`[SAM] [findLatestState] scanning message ${i}`);

            const message = chatHistory[i];
            if (message.role === "user") continue;
            const swipeContent = message.swipes?.[message.swipe_id ?? 0] ?? message.message;
            const state = parseStateFromMessage(swipeContent);
            if (state) {
                console.log(`[${SCRIPT_NAME}] State loaded from message at index ${i}.`);
                return _.cloneDeep(state);
            }
        }
        console.log(`[${SCRIPT_NAME}] No previous state found. Using initial state.`);
        return _.cloneDeep(INITIAL_STATE);
    }
    
    function goodCopy(state) {
        // Start with a clone of the NESTED static data.
        // Return the object with its nested structure intact.
        return _.cloneDeep(state) ?? {INITIAL_STATE};
    }


    // --- CORE LOGIC ---

    async function processVolatileUpdates(state) {
        if (!state.volatile?.length) return [];
        const promotedCommands = [];
        const remainingVolatiles = [];
        const currentRound = await getRoundCounter();
        const currentTime = new Date();
        for (const volatile of state.volatile) {
            const [varName, varValue, isGameTime, targetTime] = volatile;
            let triggered = isGameTime ? (currentTime >= new Date(targetTime)) : (currentRound >= targetTime);
            if (triggered) {
                promotedCommands.push({ type: 'SET', params: `${varName} :: ${varValue}` });
            } else {
                remainingVolatiles.push(volatile);
            }
        }
        state.volatile = remainingVolatiles;
        return promotedCommands;
    }


    // finally, the applyCommandsToState function applies all detected command to state.
    // it will detect all set::a::b ->

async function applyCommandsToState(commands, state) {
    const currentRound = await getRoundCounter();
    for (const command of commands) {
        //console.log(`[SAM] applyCommandsToState: processing command, with type [${command.type}] and value [${command}]`)

        const params = command.params.split('::').map(p => p.trim());

        try {
            switch (command.type) {
                // ... (SET, ADD, RESPONSE_SUMMARY cases remain unchanged)
                case 'SET': {
                    const [varName, varValue] = params; 
                    if (!varName || varValue === undefined) continue;
                    _.set(state.static, varName, isNaN(varValue) ? varValue : Number(varValue)); break;
                }
                case 'ADD': {
                    const [varName, incrementStr] = params; if (!varName || incrementStr === undefined) continue;
                    const existing = _.get(state.static, varName, 0);
                    if (Array.isArray(existing)) { existing.push(incrementStr); }
                    else {
                        const increment = Number(incrementStr); const baseValue = Number(existing) || 0;
                        if (isNaN(increment) || isNaN(baseValue)) continue;
                        _.set(state.static, varName, baseValue + increment);
                    } break;
                }
                case 'RESPONSE_SUMMARY': {
                    if (!state.responseSummary) state.responseSummary = [];
                    state.responseSummary.push(command.params.trim()); break;
                }

                // MODIFIED: TIMED_SET now handles the 'reason' parameter.
                case 'TIMED_SET': {
                    const [varName, varValue, reason, isGameTimeStr, timeUnitsStr] = params;
                    if (!varName || !varValue || !reason || !isGameTimeStr || !timeUnitsStr) continue;
                    const isGameTime = isGameTimeStr.toLowerCase() === 'true';
                    const finalValue = isNaN(varValue) ? varValue : Number(varValue);
                    const targetTime = isGameTime ? new Date(timeUnitsStr).toISOString() : currentRound + Number(timeUnitsStr);
                    // The new 'reason' field is added to the volatile array entry.
                    state.volatile.push([varName, finalValue, isGameTime, targetTime, reason]);
                    break;
                }

                // NEW CASE: Handles cancellation of scheduled events.
                case 'CANCEL_SET': {
                    if (!params[0] || !state.volatile?.length) continue;
                    const identifier = params[0];
                    const originalCount = state.volatile.length;

                    // First, try to treat the identifier as a numeric index.
                    const index = parseInt(identifier, 10);
                    if (!isNaN(index) && index >= 0 && index < state.volatile.length) {
                        state.volatile.splice(index, 1);
                        console.log(`[${SCRIPT_NAME}] Canceled timed set at index ${index}.`);
                    } else {
                        // If not a valid index, treat it as a string and match against varName or reason.
                        state.volatile = state.volatile.filter(entry => {
                            const [varName, , , , reason] = entry;
                            return varName !== identifier && reason !== identifier;
                        });
                        if (state.volatile.length < originalCount) {
                           console.log(`[${SCRIPT_NAME}] Canceled timed set(s) matching identifier "${identifier}".`);
                        }
                    }
                    break;
                }
            }
        } catch (error) { 
            console.error(`[${SCRIPT_NAME}] Error processing command: ${JSON.stringify(command)}`, error); 
        }
    }
    return state;
    
}

    // --- MAIN HANDLERS ---
    // TODO: Refactor
    // Logic incorrect. This only correlates to the LAST AI message.
    // however, we get at index anyways

    async function processMessageState(index) {
        
        // -> we must have that message at index exists. Therefore we do not need to search it down
        // getChatMessages returns an ERROR. we must try-catch it.

        

        var lastAIMessage = null;
        try{
            lastAIMessage = await getChatMessages(index)[0];
        }catch(e){
            console.log(`[SAM] processMessageState: Invalid index ${index}`);
            return;
        }

        // exc handling: if last message does not have content / role === "user" then return         
        if (!lastAIMessage || lastAIMessage.role === "user") return;


        //console.log(`[${SCRIPT_NAME}] Processing AI message at index: ${index}`);
        
        // get latest tavern variable JSON
        var state = await getVariables();

        // handle all commands scheduled to execute at T = current
        // promote all promote-able commands
        const promotedCommands = await processVolatileUpdates(state);

        var messageContent = lastAIMessage.message;

        //console.log(`[SAM] messageContent = ${messageContent}`);
        
        //console.log(`[SAM] attempting to decode message content yielded ${Array.from(messageContent.matchAll(COMMAND_REGEX))} `);

        // we need to use iterator to do it.
        // iterator through the whole content, and get each elem.

        let match;
        const results = [];

        // .exec() finds the next match in the string
        while ((match = COMMAND_REGEX.exec(messageContent)) !== null) {
        const desiredResult = {type: match.groups.type, params: match.groups.params};
        results.push(desiredResult);
        }
        const newCommands = results;

        //console.log(`[SAM] [REGEX] found command from content: ${newCommands}`);

        state = await applyCommandsToState([...promotedCommands, ...newCommands], state);


        // finally, write the newest state/ replace the newest state into the current latest message.
        await replaceVariables(goodCopy(state));
        state = await getVariables();
        
        const cleanNarrative = messageContent.replace(STATE_BLOCK_REMOVE_REGEX, '').trim();
        //console.log(`[SAM] debug message content = ${cleanNarrative} `);

        const newStateBlock = `${STATE_BLOCK_START_MARKER}\n${JSON.stringify(state, null, 2)}\n${STATE_BLOCK_END_MARKER}`;
        const finalContent = `${cleanNarrative}\n\n${newStateBlock}`;
        //console.log(`[SAM] debug final content = ${finalContent} `);

        // setting current chat message.
        index = lastAIMessage.message_id;
        await setChatMessage({message: finalContent}, index);

    }

    async function loadStateFromMessage(index) {

        var message = ""
        try {
            var message = await getChatMessages(index)[0];
        } catch (e) {
            console.log(`[SAM] Load state from message: Failed to get at index= ${index}, likely the index does not exist. SAM will keep old state. Error message: ${e}`);
            return;
        }

        //console.log(`[${SCRIPT_NAME}] Re-loading state from message at index: ${index}`);
        const messageContent = message.message;
        //console.log(`[SAM] current message is swipe ${message.swipe_id}`);

        const state = parseStateFromMessage(messageContent);
        if (state) {
            // FIX: Call the new, correct function.
            await replaceVariables(goodCopy(state));
            //console.log(`[${SCRIPT_NAME}] State re-loaded successfully.`);
        } else {
            const chatHistory = await getChatMessages(`0-${index}`);
            const lastKnownState = await findLatestState(chatHistory);
            // FIX: Call the new, correct function.
            await replaceVariables(goodCopy(lastKnownState));
            //console.log(`[${SCRIPT_NAME}] Message at index ${index} had no state. Loaded previous state instead.`);
        }
    }
    
    async function findLastAiMessageAndIndex(beforeIndex) {
        //console.log("[SAM] getting chat messages");
        const chat = await getChatMessages("0-{{lastMessageId}}");
        //console.log("[SAM] finished getting chat messages");

        // shortcut: enter -1 and it is automatically going downto 0 from max.
        if (beforeIndex === -1){
            beforeIndex = chat.length;
        }

        for (let i = beforeIndex - 1; i >= 0; i--) {
            if (chat[i].role !== "user") return i;
        }
        return -1;
    }

    // --- EVENT LISTENER REGISTRATION ---
$(async () => {
    try {
        console.log(`[${SCRIPT_NAME}] State management loading. GLHF, player.`);

        /**
         * Re-initializes the state based on the current chat's history.
         * Finds the last AI message and loads its state into the UI.
         * If no state is found, it loads the default initial state.
         */
        async function initializeOrReloadStateForCurrentChat() {
            console.log(`[${SCRIPT_NAME}] Loading state for current chat.`);
            const lastAiIndex = await findLastAiMessageAndIndex(-1);
            const lastIndex = await getChatMessages("{{lastMessageId}}")[0].message_id;
            
            // setting latest generation level.
            latest_gen_lvl = lastIndex;

            await loadStateFromMessage(lastAiIndex);
        }

        const update_events = [
            tavern_events.GENERATION_STOPPED,
            tavern_events.GENERATION_ENDED
        ];

        update_events.forEach(eventName => {
            eventOn(eventName, async () => {
                console.log(`[${SCRIPT_NAME}] detected new message`);
                try {
                    const index = SillyTavern.chat.length - 1;
                    

                    await processMessageState(index);
                } catch (error) { console.error(`[${SCRIPT_NAME}] Error in MESSAGE_RECEIVED handler:`, error); }
            });
        })

        // --- Event Handlers ---

        
        // MODIFIED: This handler is now deferred to prevent race conditions.
        eventOn(tavern_events.MESSAGE_SWIPED, (message) => {
            console.log(`[${SCRIPT_NAME}] detected swipe`);

            setTimeout(async () => {
                try {
                    const index = SillyTavern.chat.length - 1;
                    if (index !== -1) {
                        console.log("[SAM] on swipe, load previous state or keep previous state");
                        const lastAIMessageIndex = await findLastAiMessageAndIndex(-1);
                        await loadStateFromMessage(lastAIMessageIndex);
                    }
                } catch (error) {
                    console.error(`[${SCRIPT_NAME}] Error in deferred MESSAGE_SWIPED handler:`, error);
                }
            }, 0);
        });

        eventOn(tavern_events.MESSAGE_EDITED, async () => {
            console.log(`[${SCRIPT_NAME}] detected edit`);
            
            try{
                var message = (await getChatMessages("{{lastMessageId}}"))[0];

                if (message === undefined){
                    console.log("[SAM] MessageEditHandler: Received undefined value");
                    return;
                }

            } catch (e){
                console.log("[SAM] MessageEditHandler: Cannot get last message content, aborting.");
                return;
            }

            try {
                if (message.role === "user") {

                    // do NOTHING.

                } else {
                    // if it is an AI message, we do not do anything but we reload state. This allows user manipulation of things.
                    console.log("[SAM] DEBUG: detected message edit, reload last AI message state");
                    const lastAiIndex = await findLastAiMessageAndIndex(-1);
                    await loadStateFromMessage(lastAiIndex);


                    //console.log("[SAM] DEBUG: detected Message edit, ProcessMessageState triggered");
                    //await processMessageState("{{lastMessageId}}");
                }
            } catch (error) { 
                console.error(`[${SCRIPT_NAME}] Error in MESSAGE_EDITED handler:`, error); 
            }
        });

        // NEW: Add the CHAT_CHANGED listener to re-initialize state on chat load/switch.
        eventOn(tavern_events.CHAT_CHANGED, async () => {
            console.log(`[${SCRIPT_NAME}] detected new chat context load.`);
            try {
                await initializeOrReloadStateForCurrentChat();
            } catch(error) {
                console.error(`[${SCRIPT_NAME}] Error in CHAT_CHANGED handler:`, error);
            }
        });

        // Initial load for the very first time the script runs.
        await initializeOrReloadStateForCurrentChat();

    } catch (error) {
         console.error(`[${SCRIPT_NAME}] Error during initialization:`, error);
    }
});
})();
