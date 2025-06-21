// This file will contain the JavaScript logic for Scryfall API interaction and deck validation.
// It will use jQuery for DOM manipulation and AJAX requests.

const ENABLE_ADVANCED_RULES = true; // Toggle for advanced deck validation rules

$(document).ready(function() {
    // Helper function to get value from an input or textarea
    function getElementValue(elementId) {
        return $(`#${elementId}`).val().trim();
    }

    // Function to parse a decklist string (e.g., from a textarea)
    // Returns an array of objects: { name: "Card Name", quantity: X }
    function parseCardList(listString) {
        if (!listString) {
            return [];
        }
        const lines = listString.split(/\r?\n/); // Use regex for robust line splitting
        const nonEmptyLines = lines.filter(line => line.trim() !== '');
        const cardNames = {}; // Object to store card names and quantities

        nonEmptyLines.forEach(line => {
            const match = line.match(/^(\d+)?x?\s?(.*)$/i); // Allows "1 Card Name", "1x Card Name", "Card Name"
            if (match) {
                const quantity = match[1] ? parseInt(match[1].trim().replace(/x/gi, '')) : 1;
                const cardName = match[2].trim();
                const normalizedCardName = cardName.toLowerCase();

                if (cardNames[normalizedCardName]) {
                    cardNames[normalizedCardName].quantity += quantity;
                } else {
                    cardNames[normalizedCardName] = { name: cardName, quantity: quantity };
                }
            }
        });

        // Convert the object to an array
        return Object.values(cardNames);
    }

    const SCRYFALL_API_ENDPOINT = 'https://api.scryfall.com/cards/collection';
    let requestInProgress = false; // Global flag to prevent multiple simultaneous submissions

    // Function to validate a player's commander and decklist
    function validatePlayerDeck(commanderElementName, decklistElementName) {
        return new Promise((resolve, reject) => {
            const commanderName = getElementValue(commanderElementName);
            const decklistString = getElementValue(decklistElementName);

            if (!commanderName) {
                // Immediately resolve with an error if commander is missing, as it's required.
                // Or reject, depending on how we want to handle this upstream.
                // For now, let's create a structure indicating the missing commander.
                resolve({
                    commander: { name: "", scryfall_data: null, is_legal: false, error: "Commander name is missing." },
                    decklist: parseCardList(decklistString).map(card => ({ ...card, scryfall_data: null, is_legal: false, error: "Commander missing, deck not validated." })),
                    errors: ["Commander name is missing."]
                });
                return;
            }

            const parsedDecklist = parseCardList(decklistString);
            const allCardsToFetch = [{ name: commanderName, quantity: 1, isCommander: true }, ...parsedDecklist.map(c => ({...c, isCommander: false}))];

            const identifiers = allCardsToFetch.map(card => {
                let nameForScryfall = card.name.toLowerCase();
                // Scryfall expects " // " for split cards
                if (nameForScryfall.includes('//') && !nameForScryfall.includes(' // ')) {
                    nameForScryfall = nameForScryfall.replace('//', ' // ');
                }
                return { name: nameForScryfall };
            });

            let currentOffset = 0;
            let requestsMade = 0;
            let scryfallResponseData = [];
            let accumulatedNotFound = [];
            const totalBatches = Math.ceil(identifiers.length / 70);

            function makeScryfallRequest() {
                if (identifiers.length === 0) { // No cards to fetch (e.g. empty decklist and only commander)
                    // This check might be redundant if commander is always present.
                    // If only commander, identifiers will have 1 item.
                    // If commander + empty decklist, identifiers will have 1 item.
                    // If commander is missing and decklist is empty, identifiers is empty.
                    // This case should be handled by the initial commanderName check.
                    // However, if commander is present but decklist is empty, this function will still run once.
                     const finalValidatedCards = processScryfallResults([], [], allCardsToFetch);
                     resolve(finalValidatedCards);
                     return;
                }

                const requestPayload = {
                    identifiers: identifiers.slice(currentOffset, currentOffset + 70)
                };

                $.ajax({
                    url: SCRYFALL_API_ENDPOINT,
                    type: 'POST',
                    dataType: 'json',
                    contentType: 'application/json',
                    data: JSON.stringify(requestPayload),
                    success: function(response) {
                        scryfallResponseData = scryfallResponseData.concat(response.data);
                        accumulatedNotFound = accumulatedNotFound.concat(response.not_found.map(card => card.name ? card.name.toLowerCase() : card.toString().toLowerCase()));

                        requestsMade++;
                        if (requestsMade < totalBatches) {
                            currentOffset += 70;
                            setTimeout(makeScryfallRequest, 110); // Scryfall API rate limit recommendation (100ms, add a bit buffer)
                        } else {
                            // All requests completed
                            // console.log('DEBUG: Final Scryfall Data (found):', JSON.stringify(scryfallResponseData, null, 2));
                            // console.log('DEBUG: Final Scryfall Data (not_found):', JSON.stringify(accumulatedNotFound, null, 2));
                            // console.log('DEBUG: Original input cards for processing:', JSON.stringify(allCardsToFetch, null, 2));
                            const finalValidatedCards = processScryfallResults(scryfallResponseData, accumulatedNotFound, allCardsToFetch);
                            resolve(finalValidatedCards);
                        }
                    },
                    error: function(xhr, status, error) {
                        console.error('Error retrieving card data from Scryfall:', status, error, xhr.responseText);
                        // Add all cards from the failed batch to not_found
                        const failedBatchIdentifiers = requestPayload.identifiers.map(id => id.name.toLowerCase());
                        accumulatedNotFound = accumulatedNotFound.concat(failedBatchIdentifiers);

                        requestsMade++;
                        if (requestsMade < totalBatches) {
                            currentOffset += 70;
                            setTimeout(makeScryfallRequest, 110);
                        } else {
                            // All requests completed, some might have failed
                            const finalValidatedCards = processScryfallResults(scryfallResponseData, accumulatedNotFound, allCardsToFetch);
                            resolve(finalValidatedCards); // Resolve, as errors are handled per card
                        }
                    }
                });
            }

            if (identifiers.length > 0) {
                makeScryfallRequest(); // Initial call
            } else if (commanderName && parsedDecklist.length === 0) { // Only a commander was provided
                 const finalValidatedCards = processScryfallResults([], [], allCardsToFetch);
                 resolve(finalValidatedCards);
            } else { // Should not happen if commanderName check is effective
                 resolve({
                    commander: { name: commanderName, scryfall_data: null, is_legal: false, error: "No cards to validate." },
                    decklist: [],
                    errors: ["No cards to validate."]
                });
            }
        });
    }

    // Helper to process Scryfall results
    function processScryfallResults(scryfallData, notFoundNames, originalInputCards) {
        const validatedCards = {
            commander: null,
            decklist: [],
            errors: []
        };

        originalInputCards.forEach(inputCard => {
            const normalizedInputName = inputCard.name.toLowerCase(); // Keep it simple for input

            const foundScryfallCard = scryfallData.find(sc => {
                const normalizedScryfallCardName = sc.name.toLowerCase();
                if (normalizedScryfallCardName === normalizedInputName) {
                    return true; // Exact match
                }
                // Handle cases like "Kellan, Daring Traveler" (input) vs "Kellan, Daring Traveler // Journey On" (Scryfall)
                if (normalizedScryfallCardName.includes(' // ')) {
                    const frontFaceName = normalizedScryfallCardName.split(' // ')[0].trim();
                    if (frontFaceName === normalizedInputName) {
                        return true; // Matches front face
                    }
                }
                return false;
            });

            let cardEntry;

            if (foundScryfallCard) {
                const isLegal = foundScryfallCard.legalities && foundScryfallCard.legalities.commander === 'legal';
                cardEntry = {
                    name: foundScryfallCard.name, // Use Scryfall's canonical name
                    quantity: inputCard.quantity,
                    scryfall_data: foundScryfallCard,
                    is_legal: isLegal,
                    error: null
                };
                if (!isLegal) {
                    cardEntry.error = `'${foundScryfallCard.name}' is not legal in Commander.`;
                    validatedCards.errors.push(cardEntry.error);
                }
            } else {
                // Check if it was in notFoundNames (Scryfall sometimes returns slightly different names in not_found)
                const wasNotFound = notFoundNames.some(nfName => {
                    // Attempt a more robust comparison for not_found names
                    const normalizedNfName = nfName.toLowerCase().replace(/\s\/\/\s/g, '//');
                    return normalizedInputName === normalizedNfName || normalizedInputName.startsWith(normalizedNfName.split(' // ')[0]);
                });

                const errorMsg = wasNotFound ? `Card '${inputCard.name}' not found by Scryfall.` : `Data for '${inputCard.name}' missing after Scryfall fetch.`;
                cardEntry = {
                    name: inputCard.name,
                    quantity: inputCard.quantity,
                    scryfall_data: null,
                    is_legal: false,
                    error: errorMsg
                };
                validatedCards.errors.push(errorMsg);
            }

            if (inputCard.isCommander) {
                validatedCards.commander = cardEntry;
            } else {
                validatedCards.decklist.push(cardEntry);
            }
        });

        // Ensure commander entry exists even if it was not found or had issues
        if (!validatedCards.commander && originalInputCards.find(c => c.isCommander)) {
             const commanderInput = originalInputCards.find(c => c.isCommander);
             const errorMsg = `Commander '${commanderInput.name}' not found or failed to process.`;
             validatedCards.commander = {
                name: commanderInput.name,
                quantity: 1,
                scryfall_data: null,
                is_legal: false,
                error: errorMsg
             };
             if (!validatedCards.errors.includes(errorMsg)) validatedCards.errors.push(errorMsg);
        }


        return validatedCards;
    }

    const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1386069620556828874/cWcs23AdzHSkhHSKhtn8j5T8sYqH9-k4Ju2NKh0rDeYk6gqJ7y35R4uMZbZ2DtWQps9B';

    const MAX_FIELD_VALUE_LENGTH = 1000; // Max characters for a Discord embed field value (safe under 1024)

    function performAdvancedDeckValidation(player1Data, player2Data) {
        const advancedErrors = [];
        // All rule checks will go here

        // Rule 1: Total 100 cards per deck
        let p1DeckTotal = 0;
        if (player1Data && player1Data.decklist) {
            p1DeckTotal = player1Data.decklist.reduce((sum, card) => sum + card.quantity, 0);
        }
        if (player1Data && player1Data.commander && player1Data.commander.scryfall_data) { // Commander counts as 1 card if valid
            p1DeckTotal += player1Data.commander.quantity; // Should be 1
        }

        let p2DeckTotal = 0;
        if (player2Data && player2Data.decklist) {
            p2DeckTotal = player2Data.decklist.reduce((sum, card) => sum + card.quantity, 0);
        }
        if (player2Data && player2Data.commander && player2Data.commander.scryfall_data) { // Commander counts as 1 card if valid
            p2DeckTotal += player2Data.commander.quantity; // Should be 1
        }

        const deckSizeErrors = [];
        if (p1DeckTotal !== 100 && player1Data && player1Data.commander && player1Data.commander.scryfall_data) { // Only apply if commander is valid enough to count
            deckSizeErrors.push(`  - Jugador 1: Mazo tiene ${p1DeckTotal} cartas.`);
        }
        if (p2DeckTotal !== 100 && player2Data && player2Data.commander && player2Data.commander.scryfall_data) { // Only apply if commander is valid enough to count
            deckSizeErrors.push(`  - Jugador 2: Mazo tiene ${p2DeckTotal} cartas.`);
        }

        if (deckSizeErrors.length > 0) {
            advancedErrors.push("**Violación de Regla: Mazos no tienen 100 cartas**\n" + deckSizeErrors.join("\n"));
        }

        // Rule 2: Single color commanders
        const commanderColorErrors = [];
        if (player1Data && player1Data.commander && player1Data.commander.scryfall_data && player1Data.commander.scryfall_data.color_identity) {
            if (player1Data.commander.scryfall_data.color_identity.length > 1) {
                commanderColorErrors.push(`  - Comandante de Jugador 1 (${player1Data.commander.name}): Identidad de color es ${player1Data.commander.scryfall_data.color_identity.join('')}, debe ser monocolor.`);
            }
        }
        if (player2Data && player2Data.commander && player2Data.commander.scryfall_data && player2Data.commander.scryfall_data.color_identity) {
            if (player2Data.commander.scryfall_data.color_identity.length > 1) {
                commanderColorErrors.push(`  - Comandante de Jugador 2 (${player2Data.commander.name}): Identidad de color es ${player2Data.commander.scryfall_data.color_identity.join('')}, debe ser monocolor.`);
            }
        }
        if (commanderColorErrors.length > 0) {
            advancedErrors.push("**Violación de Regla: Comandantes Multi-color**\n" + commanderColorErrors.join("\n"));
        }

        // Rule 3: No repeated non-land cards between decks
        const p1NonLandCardNames = new Set();
        if (player1Data && player1Data.decklist) {
            player1Data.decklist.forEach(card => {
                if (card.scryfall_data && card.scryfall_data.type_line && !card.scryfall_data.type_line.toLowerCase().includes('land')) {
                    p1NonLandCardNames.add(card.name.toLowerCase()); // Normalize name for comparison
                }
            });
        }

        const repeatedCardErrors = [];
        if (player2Data && player2Data.decklist) {
            player2Data.decklist.forEach(card => {
                if (card.scryfall_data && card.scryfall_data.type_line && !card.scryfall_data.type_line.toLowerCase().includes('land')) {
                    if (p1NonLandCardNames.has(card.name.toLowerCase())) {
                        repeatedCardErrors.push(`  - '${card.name}' repetida entre mazos.`);
                        // To avoid reporting the same card multiple times if it's in P1's set and P2 has multiple copies (though our decklist structure is unique names with quantities)
                        // or if we were checking P1 against P2's set after this. This simple one-way check is fine.
                        // For truly unique error lines, we could add to a Set first, then format.
                    }
                }
            });
        }
        if (repeatedCardErrors.length > 0) {
             // To ensure unique error lines if a card name might appear in repeatedCardErrors due to case or other minor variations before normalization
            const uniqueRepeatedCardErrorLines = [...new Set(repeatedCardErrors)];
            advancedErrors.push("**Violación de Regla: Cartas no-tierra repetidas entre mazos**\n" + uniqueRepeatedCardErrorLines.join("\n"));
        }

        // Rule 4: Cards within combined commander color identity
        const colorIdentityErrors = [];
        let combinedCommanderColors = new Set();

        if (player1Data && player1Data.commander && player1Data.commander.scryfall_data && player1Data.commander.scryfall_data.color_identity) {
            player1Data.commander.scryfall_data.color_identity.forEach(color => combinedCommanderColors.add(color));
        }
        if (player2Data && player2Data.commander && player2Data.commander.scryfall_data && player2Data.commander.scryfall_data.color_identity) {
            player2Data.commander.scryfall_data.color_identity.forEach(color => combinedCommanderColors.add(color));
        }

        // If either commander is missing or invalid, this rule might not be applicable or might give weird results.
        // We proceed if we have at least one commander's color identity to form a basis.
        // Or, if combinedCommanderColors is empty (e.g. both colorless commanders), then only colorless cards are allowed.

        const combinedColorsString = Array.from(combinedCommanderColors).join('') || 'Colorless';

        [player1Data, player2Data].forEach((playerData, playerIndex) => {
            if (playerData && playerData.decklist) {
                playerData.decklist.forEach(card => {
                    if (card.scryfall_data && card.scryfall_data.color_identity) {
                        const cardColors = card.scryfall_data.color_identity;
                        let isAllowed = true;

                        if (cardColors.length > 0) { // Card has colors
                            if (combinedCommanderColors.size === 0) { // Commanders are colorless, card has colors
                                isAllowed = false;
                            } else { // Card has colors, commanders have colors
                                for (const color of cardColors) {
                                    if (!combinedCommanderColors.has(color)) {
                                        isAllowed = false;
                                        break;
                                    }
                                }
                            }
                        }
                        // If card is colorless (cardColors.length === 0), it's allowed by this rule.

                        if (!isAllowed) {
                            colorIdentityErrors.push(`  - Jugador ${playerIndex + 1} - Carta '${card.name}' (Identidad: ${cardColors.join('') || 'Colorless'}) está fuera de la identidad combinada de los comandantes (${combinedColorsString}).`);
                        }
                    }
                });
            }
        });

        if (colorIdentityErrors.length > 0) {
            advancedErrors.push("**Violación de Regla: Cartas fuera de la identidad de color combinada**\n" + colorIdentityErrors.join("\n"));
        }

        // Rule 5: Max 3 "Game Changers" per deck
        const gameChangerErrors = [];
        [player1Data, player2Data].forEach((playerData, playerIndex) => {
            if (playerData && playerData.decklist) {
                const gameChangerCardsInDeck = [];
                let gameChangerCount = 0;
                playerData.decklist.forEach(card => {
                    if (card.scryfall_data && card.scryfall_data.game_changer === true) {
                        gameChangerCount++;
                        gameChangerCardsInDeck.push(card.name);
                    }
                });
                // Also check commander
                if (playerData.commander && playerData.commander.scryfall_data && playerData.commander.scryfall_data.game_changer === true) {
                    gameChangerCount++;
                    gameChangerCardsInDeck.push(`${playerData.commander.name} (Comandante)`);
                }

                if (gameChangerCount > 3) {
                    gameChangerErrors.push(`  - Jugador ${playerIndex + 1}: Tiene ${gameChangerCount} Game Changers (Máx. 3).\n    - Cartas: ${gameChangerCardsInDeck.join(', ')}`);
                }
            }
        });

        if (gameChangerErrors.length > 0) {
            advancedErrors.push("**Violación de Regla: Demasiados Game Changers**\n" + gameChangerErrors.join("\n"));
        }

        return advancedErrors;
    }

    function generateDecklistFields(decklist, baseFieldName) {
        const fields = [];
        let totalQuantity = 0;

        if (!decklist || decklist.length === 0) {
            fields.push({ name: `${baseFieldName} (0 cartas)`, value: 'Ninguna carta en el mazo.', inline: false });
            return fields;
        }

        totalQuantity = decklist.reduce((sum, card) => sum + card.quantity, 0);

        let currentFieldValue = "";
        let partCounter = 0;
        const initialFieldName = `${baseFieldName} (${totalQuantity} cartas)`;

        decklist.forEach((card, index) => {
            const cardLine = `${card.quantity}x ${card.name}\n`;
            if (currentFieldValue.length + cardLine.length > MAX_FIELD_VALUE_LENGTH) {
                // Add current field before it gets too long
                fields.push({
                    name: partCounter === 0 ? initialFieldName : `${initialFieldName} (Cont. ${partCounter})`,
                    value: currentFieldValue.trim(), // Trim trailing newline if any
                    inline: false
                });
                currentFieldValue = ""; // Reset for next part
                partCounter++;
            }
            currentFieldValue += cardLine;
        });

        // Add the last remaining part
        if (currentFieldValue.length > 0) {
            fields.push({
                name: partCounter === 0 ? initialFieldName : `${initialFieldName} (Cont. ${partCounter})`,
                value: currentFieldValue.trim(),
                inline: false
            });
        }
        return fields;
    }

    function sendToDiscord(player1Data, player2Data, player1Name, player2Name) {
        console.log("Attempting to send to Discord...");
        console.log("P1 Data:", player1Data, "P1 Name:", player1Name);
        console.log("P2 Data:", player2Data, "P2 Name:", player2Name);

        const threadTitle = `${player1Name || 'Jugador 1'} & ${player2Name || 'Jugador 2'} - Team submission`;

        const payload = {
            username: "2HG Deck Registration Bot",
            avatar_url: "", // Optional: Add a URL to an image for the bot's avatar
            thread_name: threadTitle, // Moved thread_name into the payload
            embeds: []
        };

        // Player 1 Embed
        if (player1Data && player1Data.commander) {
            const p1Embed = {
                title: `Jugador 1: ${player1Name || 'Nombre no ingresado'}`,
                // color will be set later based on validation errors
                fields: [
                    { name: '-------------------------', value: '\u200B', inline: false },
                    {
                        name: "Comandante",
                        value: player1Data.commander.name, // Legal status removed, color indicates it
                        inline: false
                    },
                    { name: '-------------------------', value: '\u200B', inline: false }
                    // Decklist fields will be added below by generateDecklistFields
                ]
            };

            const p1DecklistFields = generateDecklistFields(player1Data.decklist, "Mazo");
            p1Embed.fields.push(...p1DecklistFields);

            const player1ValidationErrors = [];
            if (player1Data.commander && player1Data.commander.error) {
                player1ValidationErrors.push(`Comandante: ${player1Data.commander.error}`);
            } else if (player1Data.commander && !player1Data.commander.is_legal) {
                // Add a generic error if commander is marked illegal but no specific error message was present
                player1ValidationErrors.push(`Comandante: '${player1Data.commander.name}' es ILEGAL o NO ENCONTRADO.`);
            }

            player1Data.decklist.forEach(card => {
                if (card.error) player1ValidationErrors.push(card.error);
            });

            if (player1ValidationErrors.length > 0) {
                p1Embed.fields.push({
                    name: "Errores de Validación P1",
                    value: player1ValidationErrors.join('\n').substring(0, 1020), // Discord field value limit
                    inline: false
                });
                p1Embed.color = 15158332; // Red
            } else {
                p1Embed.color = 3066993; // Green
            }
            payload.embeds.push(p1Embed);
        }

        // Player 2 Embed
        if (player2Data && player2Data.commander) {
            const p2Embed = {
                title: `Jugador 2: ${player2Name || 'Nombre no ingresado'}`,
                // color will be set below based on errors
                fields: [
                     { name: '-------------------------', value: '\u200B', inline: false },
                    {
                        name: "Comandante",
                        value: player2Data.commander.name, // Legal status removed
                        inline: false
                    },
                    { name: '-------------------------', value: '\u200B', inline: false }
                    // Decklist fields will be added below by generateDecklistFields
                ]
            };
            const p2DecklistFields = generateDecklistFields(player2Data.decklist, "Mazo");
            p2Embed.fields.push(...p2DecklistFields);

            const player2ValidationErrors = [];
            if (player2Data.commander && player2Data.commander.error) {
                player2ValidationErrors.push(`Comandante: ${player2Data.commander.error}`);
            } else if (player2Data.commander && !player2Data.commander.is_legal) {
                 player2ValidationErrors.push(`Comandante: '${player2Data.commander.name}' es ILEGAL o NO ENCONTRADO.`);
            }

            player2Data.decklist.forEach(card => {
                if (card.error) player2ValidationErrors.push(card.error);
            });

            if (player2ValidationErrors.length > 0) {
                p2Embed.fields.push({
                    name: "Errores de Validación P2",
                    value: player2ValidationErrors.join('\n').substring(0,1020),
                    inline: false
                });
                p2Embed.color = 15158332; // Red
            } else {
                p2Embed.color = 3066993; // Green
            }
            payload.embeds.push(p2Embed);
        }

        if (payload.embeds.length === 0) {
            console.log("No data to send to Discord.");
            return Promise.resolve(); // Nothing to send
        }

        // const threadTitle = `${player1Name || 'Jugador 1'} & ${player2Name || 'Jugador 2'} - Team submission`; // Already defined above in payload
        // const webhookUrlWithThread = `${DISCORD_WEBHOOK_URL}?thread_name=${encodeURIComponent(threadTitle)}`; // No longer needed

        return $.ajax({
            type: 'POST',
            url: DISCORD_WEBHOOK_URL, // Use base URL
            contentType: 'application/json',
            data: JSON.stringify(payload),
            success: function() {
                console.log('Successfully sent data to Discord.');
            },
            error: function(xhr, status, error) {
                console.error('Error sending data to Discord:', status, error, xhr.responseText);
            }
        });
    }


    // Main validation logic (button click handler)
    $('.send-deck').on('click', function(event) {
        event.preventDefault(); // Prevent default form submission

        if (requestInProgress) {
            console.warn("Validation already in progress.");
            return;
        }
        requestInProgress = true;
        const $submitButton = $(this);
        $submitButton.prop('disabled', true).val('Analizando...');

        // Clear previous errors from the log display
        const $logWrapper = $('.log-wrapper');
        const $errorList = $logWrapper.find('.faq-a p');
        const $errorTitle = $logWrapper.find('.faq');
        $errorList.empty();
        $errorTitle.hide();
        $logWrapper.find('.faq-cont').removeClass('is-open').find('.faq-a').hide();


        console.log("Starting validation for both players...");

        Promise.all([
            validatePlayerDeck('jugador-1-comandante', 'jugador-1-mazo'),
            validatePlayerDeck('jugador-2-comandante', 'jugador-2-mazo')
        ]).then(([player1Result, player2Result]) => {
            console.log("Player 1 Validation Result:", player1Result);
            console.log("Player 2 Validation Result:", player2Result);

            // Combine all errors for display
            const allErrors = [];
            if (player1Result.errors && player1Result.errors.length > 0) {
                player1Result.errors.forEach(err => allErrors.push(`Jugador 1: ${err}`));
            }
            if (player2Result.errors && player2Result.errors.length > 0) {
                player2Result.errors.forEach(err => allErrors.push(`Jugador 2: ${err}`));
            }

            // The next step will handle localStorage and detailed error display.
            // For now, just log and prepare for error display structure.

            if (ENABLE_ADVANCED_RULES) {
                if (player1Result && player1Result.commander && player1Result.commander.scryfall_data &&
                    player2Result && player2Result.commander && player2Result.commander.scryfall_data) {
                    // Only run advanced rules if both commanders are validly fetched from Scryfall,
                    // as some rules depend on commander data.
                    // Individual card errors within playerXResult.errors are already handled by Scryfall validation.
                    const advancedRuleErrors = performAdvancedDeckValidation(player1Result, player2Result);
                    if (advancedRuleErrors.length > 0) {
                        // Add a general header for advanced rule violations if there isn't one from Scryfall
                        // allErrors.push("**Advanced Rule Violations:**"); // This might be too generic. The function itself adds specific headers.
                        advancedRuleErrors.forEach(advErr => allErrors.push(advErr)); // Add each error individually
                    }
                } else {
                    allErrors.push("No se pudieron ejecutar las reglas avanzadas porque la información de uno o ambos comandantes no está disponible.");
                }
            }


            const originalErrorTitleColor = $errorTitle.css('color'); // Store original color
            $errorList.empty(); // Clear previous messages

            if (allErrors.length > 0) {
                console.warn("Validation found errors:", allErrors);
                allErrors.forEach(err => {
                    let formattedError = err.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // Bold text between **
                    formattedError = formattedError.replace(/\n/g, '<br>'); // Newlines to <br>
                    $errorList.append(`<div>${formattedError}</div>`); // Use div for block display of each error group
                });
                const $errorTitleSvg = $errorTitle.find('svg.faq-icon').detach();
                $errorTitle.text('Oops! Hay algunos errores').css('color', '#f45d5d');
                if ($errorTitleSvg.length) {
                    $errorTitle.append($errorTitleSvg);
                }
                $errorTitle.show();

                localStorage.removeItem('validatedDecks'); // Clear any outdated valid data
            } else {
                console.log("Validation successful for both players!");
                const validatedDataForStorage = {
                    player1: player1Result,
                    player2: player2Result
                };
                try {
                    localStorage.setItem('validatedDecks', JSON.stringify(validatedDataForStorage));
                    console.log("Decks saved to localStorage:", validatedDataForStorage);
                    $errorList.append('<span>¡Mazos validados y guardados correctamente!</span><br>');
                    // $errorTitle.text('Éxito').css('color', 'green').show(); // Title will be updated after Discord send attempt

                    // Now send to Discord
                    const player1Name = getElementValue('jugador-1-nombre');
                    const player2Name = getElementValue('jugador-2-nombre');

                    sendToDiscord(player1Result, player2Result, player1Name, player2Name)
                        .then(() => {
                            $errorList.append('<span>Datos enviados a Discord.</span>');
                            const $errorTitleSvg = $errorTitle.find('svg.faq-icon').detach();
                            $errorTitle.text('Éxito Completo').css('color', 'green');
                            if ($errorTitleSvg.length) { $errorTitle.append($errorTitleSvg); }
                            $errorTitle.show();
                        })
                        .catch(() => {
                            $errorList.append('<span>Error al enviar datos a Discord. La validación local fue exitosa.</span>');
                            const $errorTitleSvg = $errorTitle.find('svg.faq-icon').detach();
                            $errorTitle.text('Éxito Parcial').css('color', 'orange');
                            if ($errorTitleSvg.length) { $errorTitle.append($errorTitleSvg); }
                            $errorTitle.show(); // Orange for partial success
                        })
                        .always(() => { // Changed from .finally to .always
                             // Ensure the log section is visible
                            if (!$logWrapper.find('.faq-cont .faq').hasClass('is-open')) {
                                $logWrapper.find('.faq-cont .faq').show().addClass("is-open").closest('.faq-cont').find('.faq-a').slideDown(200);
                            }
                        });

                } catch (e) {
                    console.error("Error saving to localStorage:", e);
                    $errorList.append(`<span>Error al guardar en localStorage: ${e.message}</span><br>`);
                    const $errorTitleSvg = $errorTitle.find('svg.faq-icon').detach();
                    $errorTitle.text('Oops! Hay algunos errores').css('color', '#f45d5d');
                    if ($errorTitleSvg.length) { $errorTitle.append($errorTitleSvg); }
                    $errorTitle.show();
                }
            }
            // Ensure the log section is visible if there's any message (error or success from validation part)
            // This will be re-evaluated after Discord send attempt in the success case.
            if ($errorList.children().length > 0 && allErrors.length > 0) { // Only show if initial validation had errors
                if (!$logWrapper.find('.faq-cont .faq').hasClass('is-open')) {
                    $logWrapper.find('.faq-cont .faq').show().addClass("is-open").closest('.faq-cont').find('.faq-a').slideDown(200);
                }
            }

        }).catch(error => {
            // This catch is for unexpected errors in Promise.all or validatePlayerDeck promise rejections
            // Individual card errors are handled within playerXResult.errors
            console.error("Critical error during validation process:", error);
            $errorList.empty(); // Clear previous messages before adding new critical error
            $errorList.append(`<span>Error crítico durante la validación: ${error.message || error}</span><br>`);
            const $errorTitleSvg = $errorTitle.find('svg.faq-icon').detach();
            $errorTitle.text('Oops! Error Crítico').css('color', '#f45d5d');
            if ($errorTitleSvg.length) { $errorTitle.append($errorTitleSvg); }
            $errorTitle.show();
            if (!$logWrapper.find('.faq-cont .faq').hasClass('is-open')) {
               $logWrapper.find('.faq-cont .faq').show().addClass("is-open").closest('.faq-cont').find('.faq-a').slideDown(200);
           }
        }).finally(() => {
            requestInProgress = false;
            $submitButton.prop('disabled', false).val('Analizar listas y enviar');
        });
    });

});
