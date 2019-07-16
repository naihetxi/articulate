import _ from 'lodash';
import {
    MODEL_ACTION,
    MODEL_AGENT,
    MODEL_CATEGORY,
    MODEL_KEYWORD,
    PARAM_DOCUMENT_RASA_RESULTS,
    RASA_INTENT_SPLIT_SYMBOL,
    CSO_CATEGORIES,
    MODEL_POST_FORMAT,
    CSO_TIMEZONE_DEFAULT
} from '../../../util/constants';
import RedisErrorHandler from '../../errors/redis.error-handler';

const getAgentModifiers = ({ agentKeywords }) => {

    const agentModifiers = _.flatten(_.map(agentKeywords, (keyword) => {

        return _.map(keyword.modifiers, (modifier) => {

            modifier.keyword = keyword.keywordName;
            return modifier;
        });
    }));
    return agentModifiers;
};

const getActionData = ({ actionName, CSO }) => {

    return _.find(CSO.agent.actions, (agentAction) => {

        return agentAction.actionName === actionName;
    });
}


const getModifierData = ({ recognizedModifierName, CSO }) => {

    return _.find(CSO.agent.modifiers, (agentModifier) => {

        return agentModifier.modifierName === recognizedModifierName;
    });
}


const getActionToModify = ({ recognizedModifier, CSO }) => {

    let actionToModify;

    /*
    * We are going to explore the whole action, looking for the actions that could be modified by the 
    * recognized mofifier. Here we do not discrimante between fulfilled or unfulfilled actions
    */
    const possibleModifiableActions = _.compact(CSO.context.actionQueue.map((action, actionIndex) => {

        const actionData = getActionData({ actionName: action.name, CSO });
        const isCandidate = actionData.slots.some((actionSlot) => {

            return actionSlot.keyword === recognizedModifier.keyword;
        });
        if (isCandidate){
            return {
                actionData,
                index: actionIndex
            }
        }
        return null;
    }));
    //We are going to return the oldest modifiable unfulfilled action
    const oldestModifiableUnfulfilledAction = _.find(possibleModifiableActions, (possibleModifiableAction) => { return !possibleModifiableAction.fulfilled });

    //In case all the actions in the queue are already fulfilled, we are going to modify the newest modifiable action
    actionToModify = oldestModifiableUnfulfilledAction ? oldestModifiableUnfulfilledAction : possibleModifiableActions[possibleModifiableActions.length - 1];

    return actionToModify;
};

module.exports = async function ({ id, sessionId, text, timezone, debug = false, additionalKeys = null }) {

    try {
        const { redis } = this.server.app;
        const { agentService, contextService, globalService, documentService } = await this.server.services();
    
        const CSO = {
            text,
            sessionId,
            sendMessage: true,
            recognizedActions: [],
            recognizedModifiers: [],
            recognizedKeywords: [],
            webhooks: [],
            processedResponses: []
        };
    
        const AgentModel = await redis.factory(MODEL_AGENT, id);
        CSO.agent = AgentModel.allProperties();
        CSO.agent.actions = await globalService.loadAllLinked({ parentModel: AgentModel, model: MODEL_ACTION, returnModel: false });
        CSO.agent.keywords = await globalService.loadAllLinked({ parentModel: AgentModel, model: MODEL_KEYWORD, returnModel: false });
        CSO.agent.modifiers = getAgentModifiers({ agentKeywords: CSO.agent.keywords });
        CSO.timezone = timezone || CSO.agent.timezone || CSO_TIMEZONE_DEFAULT;
    
        //We need to transform agent categories into a dir because response could use category params and this will help to get values
        const agentCategories = await globalService.loadAllLinked({ parentModel: AgentModel, model: MODEL_CATEGORY, returnModel: false });
        CSO[CSO_CATEGORIES] = {}
        agentCategories.forEach((agentCategory) => {
    
            CSO[CSO_CATEGORIES][agentCategory.categoryName] = agentCategory;
        });
        
        const ParsedDocument = await agentService.parse({ AgentModel, text, timezone, returnModel: true, sessionId });
        CSO.docId = ParsedDocument.id;
        CSO.parse = ParsedDocument[PARAM_DOCUMENT_RASA_RESULTS];
    
        CSO.context = await contextService.findOrCreateSession({ sessionId, loadFrames: true });
    
        CSO.rasaResult = await agentService.converseGetBestRasaResult({ CSO });

        if (!_.isEmpty(additionalKeys)) {
            _.mapKeys(additionalKeys, (value, key) => {

                if (!CSO[key]) {
                    CSO[key] = value;
                }
            });
        }
    
        if (CSO.rasaResult.action && CSO.rasaResult.action.name){
    
            /*
            * This is the result action of RASA it could be a multiaction, a single action or a modifier
            * We don't support action + modifiers recognition, we can just do single action, 
            * multi action or single modifier recognition
            */
            const recognizedActionsNames = CSO.rasaResult.action.name.split(RASA_INTENT_SPLIT_SYMBOL);
    
            //We extract from the rasa result the recognized actions names
            CSO.recognizedActions = _.filter(recognizedActionsNames, (recognizedActionName) => {
    
                return CSO.agent.actions.some((agentAction) => {
    
                    return agentAction.actionName === recognizedActionName;
                });
            });
    
            /*
            * We extract from the rasa result the recognized modifiers
            * Currently we don't have a multimodifier recognition, but, this can support it
            */
            CSO.recognizedModifiers = _.filter(recognizedActionsNames, (recognizedActionName) => {
    
                return CSO.agent.modifiers.some((agentModifier) => {
    
                    return agentModifier.modifierName === recognizedActionName;
                });
            });
    
            //We extract the keywords from the best rasa result
            CSO.recognizedKeywords = await agentService.converseGetKeywordsFromRasaResults({ rasaResults: [ CSO.rasaResult ] })
    
            /*
            * Given that we don't have actions + modifiers models, we know that if there is a modifier, then we know that this is
            * what we need to process. Remember we don't support multi modifier models, but, we iterate as if we have it
            */
            if (CSO.recognizedModifiers.length > 0){
    
                CSO.recognizedModifiers.forEach(async (recognizedModifierName) => {
    
                    if (CSO.context.actionQueue.length > 0){

                        const recognizedModifier = getModifierData({ recognizedModifierName, CSO });
                        const actionToModify = getActionToModify({ recognizedModifier, CSO });
    
                        if (actionToModify && actionToModify.actionData.slots && actionToModify.actionData.slots.length > 0){
                            CSO.currentAction = CSO.context.actionQueue[actionToModify.index];
                            agentService.converseFillActionSlots({ actionData: actionToModify.actionData, CSO, recognizedModifier });
                        }
                        else {
                            //Return fallback because this means user send a modifier for an action that doesn't exists in the queue
                            const fallback = await agentService.converseGenerateResponseFallback({ CSO });
                            await agentService.converseSendResponseToUbiquity({ CSO, response: fallback });
                        }
                    }
                    else {
                        //Return fallback because this means user started the conversation with a modifier
                        const fallback = await agentService.converseGenerateResponseFallback({ CSO });
                        await agentService.converseSendResponseToUbiquity({ CSO, response: fallback });
                    }
                });
            }
    
            /*
            * We are going to concat the recognized actions to the action queue of the context.
            * If a modifier was recognized, then nothing will be concatenated as we don't recognize modifiers
            * and actions at the same time
            */
            CSO.recognizedActions.forEach((recognizedAction) => {
    
                CSO.context.actionQueue.push({
                    name: recognizedAction,
                    fulfilled: false
                })
            });
        
            /*
            * Once we have every action in the actionQueue, we are going to process that action queue to get responses
            */
            //TODO: CHANGE TO WHILE
            CSO.actionIndex = 0;
            while(CSO.context.actionQueue[CSO.actionIndex] !== undefined){
                
                const action = CSO.context.actionQueue[CSO.actionIndex];
                if (!action.fulfilled){
                    const actionData = getActionData({ actionName: action.name, CSO });
                    CSO.currentAction = CSO.context.actionQueue[CSO.actionIndex];
    
                    if (actionData.slots && actionData.slots.length > 0){
                        await agentService.converseFillActionSlots({ actionData, CSO });
                    }
    
                    let response;
                    if (CSO.sendMessage){

                        let postFormatPayloadToUse, usedPostFormatAction, finalResponse, converseResult, fullConverseResult;

                        response = await agentService.converseGenerateResponse({ actionData, CSO });

                        if (response.webhook) {
                            CSO.webhooks.push(response.webhook);
                        }

                        const cleanResponse = {
                            docId: CSO.docId,
                            textResponse: response.textResponse,
                            fulfilled: response.fulfilled,
                            actions: response.actions ? response.actions : [],
                            isFallback: response.isFallback
                        };
                
                        //As the action wasn't fulfilled we are not going to send any more messages to the user
                        if (!response.fulfilled){
                            CSO.sendMessage = false
                        }
                        else {
                            CSO.currentAction.fulfilled = true;
            
                            //If there is any chained action
                            if (response.actions && response.actions.length > 0){
                                let newActionIndex = CSO.actionIndex + 1;
                                response.actions.forEach((chainedAction) => {
                                    
                                    CSO.context.actionQueue.splice(newActionIndex, 0, {
                                        name: chainedAction,
                                        fulfilled: false
                                    });
                                    newActionIndex++;
                                });
                            }
                        }

                        if ((actionData && actionData.usePostFormat) || CSO.agent.usePostFormat) {
                            let modelPath, postFormat;
                            if (actionData && actionData.usePostFormat){
                                modelPath = [
                                    {
                                        model: MODEL_AGENT,
                                        id: CSO.agent.id
                                    },
                                    {
                                        model: MODEL_ACTION,
                                        id: actionData.id
                                    },
                                    {
                                        model: MODEL_POST_FORMAT
                                    }
                                ];
                                usedPostFormatAction = true;
                                postFormat = await globalService.findInModelPath({ modelPath, isFindById: false, isSingleResult: true });
                            }
                            else {
                                modelPath = [
                                    {
                                        model: MODEL_AGENT,
                                        id: CSO.agent.id
                                    },
                                    {
                                        model: MODEL_POST_FORMAT
                                    }
                                ];
                                usedPostFormatAction = false;
                                postFormat = await globalService.findInModelPath({ modelPath, isFindById, isSingleResult, skip, limit, direction, field });
                            }
                            postFormatPayloadToUse = postFormat.postFormatPayload;
                        }
                        if (postFormatPayloadToUse) {
                            try {
                                const compiledPostFormat = handlebars.compile(postFormatPayloadToUse);
                                const processedPostFormat = compiledPostFormat({ ...CSO, ...{ textResponse: cleanResponse.textResponse } });
                                const processedPostFormatJson = JSON.parse(processedPostFormat);

                                allProcessedPostFormat = { ...allProcessedPostFormat, ...processedPostFormatJson };
                                finalResponse = { ...cleanResponse, ...processedPostFormatJson };
                            }
                            catch (error) {
                                const errorMessage = usedPostFormatAction ? 'Error formatting the post response using action POST format : ' : 'Error formatting the post response using agent POST format : ';
                                console.error(errorMessage, error);
                                const responseWithError = { ...{ postFormatting: errorMessage + error }, cleanResponse };
                                finalResponse = responseWithError;
                            }
                        }
                        else {
                            finalResponse = cleanResponse;
                        }

                        CSO.processedResponses.push(finalResponse);

                        converseResult = {
                            ...finalResponse,
                            responses: CSO.processedResponses
                        };

                        const prunnedCSO = {
                            docId: CSO.docId,
                            context: CSO.context,
                            currentAction: CSO.currentAction,
                            parse: CSO.parse,
                            webhooks: CSO.processedWebhooks
                        };

                        fullConverseResult = {
                            ...converseResult,
                            CSO: prunnedCSO
                        };

                        await documentService.update({ 
                            id: CSO.docId,
                            data: { 
                                converseResult: fullConverseResult
                            }
                        });

                        if (CSO.context.docIds.indexOf(converseResult.docId) === -1){
                            CSO.context.docIds.push(converseResult.docId);
                        }
            
                        await contextService.update({
                            sessionId: CSO.context.sessionId,
                            data: {
                                savedSlots: CSO.context.savedSlots,
                                docIds: CSO.context.docIds,
                                actionQueue: CSO.context.actionQueue
                            }
                        });

                        /*
                        * This would either send a response, a text promt or a fallback
                        * CSO.ubiquity could be filled by using the additionalKeys param
                        */
                        await agentService.converseSendResponseToUbiquity({ CSO, response: debug ? fullConverseResult : converseResult });
                    }
                }
                CSO.actionIndex++;
            }
        }
        else {
            const fallback = await agentService.converseGenerateResponseFallback({ CSO });
            await agentService.converseSendResponseToUbiquity({ CSO, response: fallback });
        }
        return CSO;
    }
    catch (error) {
        if (error.isParseError){
            if (error.missingCategories){
                return {
                    textResponse: 'I don\'t have any knowledge in my brain yet. Please teach me something.'
                }
            }
            if (error.missingTrainedCategories || error.missingTrainingAtAll){
                return {
                    textResponse: error.message
                }
            }
        }
        throw RedisErrorHandler({ error });
    }

};
