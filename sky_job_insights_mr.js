/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 */
define(['N/record', 'N/search', 'N/llm', 'N/log'],
(record, search, llm, log) => {

    /**
     * getInputData — loads jobs missing order insights from saved search
     */
    const getInputData = () => {
        return search.load({
            id: 'customsearch_jobs_missing_order_summary'
        });
    };

    /**
     * map — processes one job record per key
     * Loads the linked SO, checks for Splitship, filters lines by item group, calls LLM, writes insights
     */
    const map = (context) => {
        try {
            const searchResult = JSON.parse(context.value);
            const jobId     = searchResult.id;
            const soId      = searchResult.values['custrecord_sky_sales_order']?.value
                           || searchResult.values['custrecord_sky_sales_order']
                           || null;
            const itemGroup = searchResult.values['custrecord_sky_item_group']?.value
                           || searchResult.values['custrecord_sky_item_group']
                           || null;

            if (!soId || !itemGroup) {
                log.error('Map - Missing Fields', `Job ${jobId}: soId=${soId} | itemGroup=${itemGroup} — check saved search columns.`);
                return;
            }

            log.debug('Map - Processing', `Job: ${jobId} | SO: ${soId} | Item Group: ${itemGroup}`);

            // 1. Load SO and get total line count
            const soRec = record.load({ type: record.Type.SALES_ORDER, id: soId });
            const lineCount = soRec.getLineCount({ sublistId: 'item' });

            // Read SO header fields
            const shipDateMessage = soRec.getText({ fieldId: 'custbody_sky_ship_date_message_stored' });

            // 2. Check for +SPLITSHIP anywhere on the SO — no item group filter
            let hasSplitship = false;
            for (let i = 0; i < lineCount; i++) {
                const itemName = soRec.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });
                if (itemName && itemName.toUpperCase().includes('SPLITSHIP')) {
                    hasSplitship = true;
                    break;
                }
            }

            // 3. Collect lines matching this job's item group only
            const lineData = [];
            for (let i = 0; i < lineCount; i++) {
                const clusterNum = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol_extend_clusternum',
                    line: i
                });

                if (String(clusterNum) !== String(itemGroup)) continue;

                const itemName = soRec.getSublistText({ sublistId: 'item', fieldId: 'item',         line: i });
                const qty      = soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',    line: i });
                const desc     = soRec.getSublistValue({ sublistId: 'item', fieldId: 'description', line: i });

                if (itemName || desc) {
                    lineData.push(`- Item: ${itemName || 'N/A'} | Qty: ${qty || 'N/A'} | Description: ${desc || 'No description'}`);
                }
            }

            if (!lineData.length) {
                log.error('Map - No Lines', `Job ${jobId}: no lines match Item Group ${itemGroup} on SO ${soId}.`);
                return;
            }

            // 4. Build prompt
            const soNumber = soRec.getValue({ fieldId: 'tranid' });

            const prompt = `You are a production assistant for a promotional products company.

Below are the line item descriptions from Sales Order ${soNumber}, Item Group ${itemGroup}:

${lineData.join('\n')}

Ship Date Message: ${shipDateMessage || 'None'}
Splitship Item on Order: ${hasSplitship ? 'YES' : 'NO'}

Read the descriptions and extract ONLY special handling instructions such as:
collation, custom packaging, labeling, kitting, special assembly requirements, or any shipping date constraints or delivery instructions from the ship date message.
If Splitship Item on Order is YES, always include a bullet flagging it.

Do NOT mention item names, quantities, colors, or imprint methods.
If nothing special is mentioned, write: "No special handling required."
After adding this information bring the bullet points from the Ship Date Message field.
Return bullet points only. Maximum 10 bullets. Each bullet 10 words or less.`;

            // 5. Call LLM
            const llmResponse = llm.generateText({
                prompt: prompt,
                modelParameters: { temperature: 0.2, maxTokens: 150 }
            });

            log.debug('Map - Result', `Job ${jobId}: ${llmResponse.text}`);

            // 6. Write insights back to Job record
            record.submitFields({
                type: 'customrecord_sky_job',
                id: jobId,
                values: { custrecord_sky_order_insights: llmResponse.text },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.debug('Map - Done', `Job ${jobId} insights written successfully.`);

        } catch (e) {
            log.error('Map - Error', `${e.message} | ${e.stack}`);
        }
    };

    /**
     * summarize — logs completion stats and any errors
     */
    const summarize = (context) => {
        log.debug('Summarize - Complete', `Units processed: ${context.mapSummary.usage.unitCount}`);
        context.mapSummary.errors.iterator().each((key, error) => {
            log.error('Summarize - Error', `Key: ${key} | ${error}`);
            return true;
        });
    };

    return { getInputData, map, summarize };
});