// This file will contain the JavaScript logic for Scryfall API interaction and deck validation.
// It will use jQuery for DOM manipulation and AJAX requests.

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
        const lines = listString.split('\\n');
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
            const normalizedInputName = inputCard.name.toLowerCase().replace(/\s\/\/\s/g, '//'); // Normalize for comparison
            const foundScryfallCard = scryfallData.find(sc => sc.name.toLowerCase().replace(/\s\/\/\s/g, '//') === normalizedInputName);

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

    function sendToDiscord(player1Data, player2Data, player1Name, player2Name) {
        console.log("Attempting to send to Discord...");
        console.log("P1 Data:", player1Data, "P1 Name:", player1Name);
        console.log("P2 Data:", player2Data, "P2 Name:", player2Name);

        const payload = {
            username: "2HG Deck Registration Bot",
            avatar_url: "", // Optional: Add a URL to an image for the bot's avatar
            embeds: []
        };

        // Player 1 Embed
        if (player1Data && player1Data.commander) {
            const p1Embed = {
                title: `Jugador 1: ${player1Name || 'Nombre no ingresado'}`,
                color: player1Data.errors && player1Data.errors.length > 0 ? 15158332 : 3066993, // Red for errors, Green for success (approx)
                fields: [
                    {
                        name: "Comandante",
                        value: player1Data.commander.name + (player1Data.commander.is_legal ? " (Legal)" : " (ILEGAL / NO ENCONTRADO)"),
                        inline: false
                    },
                    {
                        name: "Mazo",
                        value: `${player1Data.decklist ? player1Data.decklist.length : 0} cartas. ${
                            player1Data.decklist && player1Data.decklist.length > 0 ?
                            `Primeras cartas: \\n${player1Data.decklist.slice(0, 5).map(c => `${c.quantity}x ${c.name}`).join('\\n')}` : ''
                        }`,
                        inline: false
                    }
                ]
            };
             // Add player-specific errors to their embed
            const player1ValidationErrors = [];
            if (player1Data.commander && player1Data.commander.error) player1ValidationErrors.push(`Comandante: ${player1Data.commander.error}`);
            player1Data.decklist.forEach(card => { if (card.error) player1ValidationErrors.push(card.error); });

            if (player1ValidationErrors.length > 0) {
                p1Embed.fields.push({
                    name: "Errores de Validación P1",
                    value: player1ValidationErrors.join('\\n').substring(0, 1020), // Discord field value limit
                    inline: false
                });
                 p1Embed.color = 15158332; // Red
            } else if (player1Data.commander && player1Data.commander.is_legal === false) {
                 p1Embed.color = 15158332; // Red if commander is illegal, even if no other errors
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
                    {
                        name: "Comandante",
                        value: player2Data.commander.name + (player2Data.commander.is_legal ? " (Legal)" : " (ILEGAL / NO ENCONTRADO)"),
                        inline: false
                    },
                    {
                        name: "Mazo",
                        value: `${player2Data.decklist ? player2Data.decklist.length : 0} cartas. ${
                            player2Data.decklist && player2Data.decklist.length > 0 ?
                            `Primeras cartas: \\n${player2Data.decklist.slice(0,5).map(c => `${c.quantity}x ${c.name}`).join('\\n')}`: ''
                        }`,
                        inline: false
                    }
                ]
            };
            const player2ValidationErrors = [];
            if (player2Data.commander && player2Data.commander.error) player2ValidationErrors.push(`Comandante: ${player2Data.commander.error}`);
            player2Data.decklist.forEach(card => { if (card.error) player2ValidationErrors.push(card.error); });

            if (player2ValidationErrors.length > 0) {
                p2Embed.fields.push({
                    name: "Errores de Validación P2",
                    value: player2ValidationErrors.join('\\n').substring(0,1020),
                    inline: false
                });
                p2Embed.color = 15158332; // Red
            } else if (player2Data.commander && player2Data.commander.is_legal === false) {
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

        return $.ajax({
            type: 'POST',
            url: DISCORD_WEBHOOK_URL,
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

            const originalErrorTitleColor = $errorTitle.css('color'); // Store original color
            $errorList.empty(); // Clear previous messages

            if (allErrors.length > 0) {
                console.warn("Validation found errors:", allErrors);
                allErrors.forEach(err => $errorList.append(`<span>${err}</span><br>`));
                $errorTitle.text('Oops! Hay algunos errores').css('color', '#f45d5d').show(); // Set text and error color

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
                            $errorTitle.text('Éxito Completo').css('color', 'green').show();
                        })
                        .catch(() => {
                            $errorList.append('<span>Error al enviar datos a Discord. La validación local fue exitosa.</span>');
                            $errorTitle.text('Éxito Parcial').css('color', 'orange').show(); // Orange for partial success
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
                    $errorTitle.text('Oops! Hay algunos errores').css('color', '#f45d5d').show();
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
            $errorTitle.text('Oops! Error Crítico').css('color', '#f45d5d').show();
            if (!$logWrapper.find('.faq-cont .faq').hasClass('is-open')) {
               $logWrapper.find('.faq-cont .faq').show().addClass("is-open").closest('.faq-cont').find('.faq-a').slideDown(200);
           }
        }).finally(() => {
            requestInProgress = false;
            $submitButton.prop('disabled', false).val('Analizar listas y enviar');
        });
    });

});
