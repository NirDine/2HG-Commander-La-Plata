// This file will contain the JavaScript logic for Scryfall API interaction and deck validation.
// It will use jQuery for DOM manipulation and AJAX requests.

// ADDED: Variable to control registration form visibility
const isRegistrationFull = false; // Set to true to close registration

const ENABLE_ADVANCED_RULES = true; // Toggle for advanced deck validation rules
let validationDotAnimationInterval = null;
let sendDotAnimationInterval = null;
let originalValidateButtonText = "";
let originalSendButtonText = "";

let decksAreValid = false; // Global state for validation status
let validatedDeckData = null; // Store validated deck data for sending

// ADDED: Function to control registration form and message visibility
function setupRegistrationFormVisibility() {
    var registrationFormContainer = $("#registrationFormContainer");
    var registrationClosedMessage = $("#register #registrationClosedMessageContent"); // UPDATED selector
    var registerWrapperParagraphs = $("#register .dwn-wrapper p"); // ADDED selector for paragraphs

    if (isRegistrationFull) {
        if (registrationFormContainer.length) {
            registrationFormContainer.hide();
        }
        if (registerWrapperParagraphs.length) {
            // ADDED logic to hide paragraphs
            registerWrapperParagraphs.hide();
        }
        if (registrationClosedMessage.length) {
            registrationClosedMessage.show();
        }
    } else {
        if (registrationFormContainer.length) {
            registrationFormContainer.show();
        }
        if (registerWrapperParagraphs.length) {
            // ADDED logic to show paragraphs
            registerWrapperParagraphs.show();
        }
        if (registrationClosedMessage.length) {
            registrationClosedMessage.hide();
        }
    }
}

$(document).ready(function () {
    setupRegistrationFormVisibility(); // ADDED: Call the function to set initial visibility

    const $validateButton = $("#validate-decks-button");
    const $sendButton = $("#send-decks-button");
    const $logWrapper = $(".log-wrapper");
    const $errorList = $logWrapper.find(".faq-a p");
    const $errorTitle = $logWrapper.find(".faq");

    // Store original button texts
    if ($validateButton.length) originalValidateButtonText = $validateButton.text();
    if ($sendButton.length) originalSendButtonText = $sendButton.val();


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
        const nonEmptyLines = lines.filter((line) => line.trim() !== "");
        const cardNames = {}; // Object to store card names and quantities

        nonEmptyLines.forEach((line) => {
            const match = line.match(/^(\d+)?x?\s?(.*)$/i); // Allows "1 Card Name", "1x Card Name", "Card Name"
            if (match) {
                const quantity = match[1] ? parseInt(match[1].trim().replace(/x/gi, "")) : 1;
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

    const SCRYFALL_API_ENDPOINT = "https://api.scryfall.com/cards/collection";
    let validationRequestInProgress = false;
    let sendRequestInProgress = false;


    // Function to validate a player's commander and decklist
    function validatePlayerDeck(commanderElementName, decklistElementName) {
        return new Promise((resolve, reject) => {
            const commanderName = getElementValue(commanderElementName);
            const decklistString = getElementValue(decklistElementName);

            if (!commanderName) {
                resolve({
                    commander: { name: "", scryfall_data: null, is_legal: false, error: "Commander name is missing." },
                    decklist: parseCardList(decklistString).map((card) => ({
                        ...card,
                        scryfall_data: null,
                        is_legal: false,
                        error: "Commander missing, deck not validated."
                    })),
                    errors: ["Commander name is missing."]
                });
                return;
            }

            const parsedDecklist = parseCardList(decklistString);
            const allCardsToFetch = [
                { name: commanderName, quantity: 1, isCommander: true },
                ...parsedDecklist.map((c) => ({ ...c, isCommander: false }))
            ];

            const identifiers = allCardsToFetch.map((card) => {
                let nameForScryfall = card.name.toLowerCase();
                // This handles "Card Name // Other Name" or "Card Name / Other Name"
                if (nameForScryfall.includes("//")) {
                    nameForScryfall = nameForScryfall.split("//")[0].trim();
                } else if (nameForScryfall.includes("/")) {
                    nameForScryfall = nameForScryfall.split("/")[0].trim();
                }
                return { name: nameForScryfall };
            });

            let currentOffset = 0;
            let requestsMade = 0;
            let scryfallResponseData = [];
            let accumulatedNotFound = [];
            const totalBatches = Math.ceil(identifiers.length / 70);

            function makeScryfallRequest() {
                if (identifiers.length === 0) {
                    const finalValidatedCards = processScryfallResults([], [], allCardsToFetch);
                    resolve(finalValidatedCards);
                    return;
                }

                const requestPayload = {
                    identifiers: identifiers.slice(currentOffset, currentOffset + 70)
                };

                $.ajax({
                    url: SCRYFALL_API_ENDPOINT,
                    type: "POST",
                    dataType: "json",
                    contentType: "application/json",
                    data: JSON.stringify(requestPayload),
                    success: function (response) {
                        scryfallResponseData = scryfallResponseData.concat(response.data);
                        accumulatedNotFound = accumulatedNotFound.concat(
                            response.not_found.map((card) =>
                                card.name ? card.name.toLowerCase() : card.toString().toLowerCase()
                            )
                        );
                        requestsMade++;
                        if (requestsMade < totalBatches) {
                            currentOffset += 70;
                            setTimeout(makeScryfallRequest, 110);
                        } else {
                            const finalValidatedCards = processScryfallResults(
                                scryfallResponseData,
                                accumulatedNotFound,
                                allCardsToFetch
                            );
                            resolve(finalValidatedCards);
                        }
                    },
                    error: function (xhr, status, error) {
                        console.error("Error retrieving card data from Scryfall:", status, error, xhr.responseText);
                        const failedBatchIdentifiers = requestPayload.identifiers.map((id) => id.name.toLowerCase());
                        accumulatedNotFound = accumulatedNotFound.concat(failedBatchIdentifiers);
                        requestsMade++;
                        if (requestsMade < totalBatches) {
                            currentOffset += 70;
                            setTimeout(makeScryfallRequest, 110);
                        } else {
                            const finalValidatedCards = processScryfallResults(
                                scryfallResponseData,
                                accumulatedNotFound,
                                allCardsToFetch
                            );
                            resolve(finalValidatedCards);
                        }
                    }
                });
            }

            if (identifiers.length > 0) {
                makeScryfallRequest();
            } else if (commanderName && parsedDecklist.length === 0) {
                const finalValidatedCards = processScryfallResults([], [], allCardsToFetch);
                resolve(finalValidatedCards);
            } else {
                resolve({
                    commander: {
                        name: commanderName,
                        scryfall_data: null,
                        is_legal: false,
                        error: "No cards to validate."
                    },
                    decklist: [],
                    errors: ["No cards to validate."]
                });
            }
        });
    }

    // Function to perform a fuzzy search for a single card
    function fuzzySearch(cardName) {
        return new Promise((resolve, reject) => {
            const fuzzyUrl = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cardName)}`;
            setTimeout(() => {
                $.ajax({
                    url: fuzzyUrl,
                    type: "GET",
                    dataType: "json",
                    success: function (response) {
                        resolve(response);
                    },
                    error: function (xhr, status, error) {
                        // It's a 404 if not found, which is expected.
                        if (xhr.status === 404) {
                            resolve(null); // Resolve with null to indicate not found
                        } else {
                            // For other errors, reject
                            console.error(`Fuzzy search failed for ${cardName}:`, status, error);
                            reject(error);
                        }
                    }
                });
            }, 110); // Respect Scryfall's rate limit
        });
    }

    async function processScryfallResults(scryfallData, notFoundNames, originalInputCards) {
        const validatedCards = {
            commander: null,
            decklist: [],
            errors: []
        };
        let fuzzySearchErrors = 0;

        for (const inputCard of originalInputCards) {
            let normalizedInputName = inputCard.name.toLowerCase();
            if (normalizedInputName.includes("//")) {
                normalizedInputName = normalizedInputName.split("//")[0].trim();
            } else if (normalizedInputName.includes("/")) {
                normalizedInputName = normalizedInputName.split("/")[0].trim();
            }

            let foundScryfallCard = scryfallData.find((sc) => {
                const normalizedScryfallCardName = sc.name.toLowerCase();
                if (normalizedScryfallCardName === normalizedInputName) return true;
                if (normalizedScryfallCardName.includes(" // ") && normalizedScryfallCardName.split(" // ")[0].trim() === normalizedInputName) return true;
                if (sc.card_faces) {
                    for (const face of sc.card_faces) {
                        if (face.name.toLowerCase() === normalizedInputName) return true;
                    }
                }
                return false;
            });

            // If not found in the initial batch, try a fuzzy search
            if (!foundScryfallCard && notFoundNames.includes(normalizedInputName) && fuzzySearchErrors < 3) {
                try {
                    const fuzzyResult = await fuzzySearch(inputCard.name);
                    if (fuzzyResult) {
                        foundScryfallCard = fuzzyResult;
                        // Remove from notFoundNames to avoid duplicate error messages
                        const index = notFoundNames.indexOf(normalizedInputName);
                        if (index > -1) {
                            notFoundNames.splice(index, 1);
                        }
                    }
                } catch (error) {
                    fuzzySearchErrors++;
                    if (fuzzySearchErrors >= 3) {
                        validatedCards.errors.push("Se detuvo la búsqueda difusa debido a múltiples errores de red. Por favor, revise su conexión o intente más tarde.");
                    }
                }
            }


            let cardEntry;
            if (foundScryfallCard) {
                const isLegal = foundScryfallCard.legalities && foundScryfallCard.legalities.commander === "legal";
                cardEntry = {
                    name: foundScryfallCard.name,
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
                const errorMsg = `Card '${inputCard.name}' not found by Scryfall.`;
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
        }

        if (!validatedCards.commander && originalInputCards.find((c) => c.isCommander)) {
            const commanderInput = originalInputCards.find((c) => c.isCommander);
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

    const DISCORD_WEBHOOK_URL =
        "https://discord.com/api/webhooks/1386069620556828874/cWcs23AdzHSkhHSKhtn8j5T8sYqH9-k4Ju2NKh0rDeYk6gqJ7y35R4uMZbZ2DtWQps9B";
    const MAX_FIELD_VALUE_LENGTH = 1000;

    function performAdvancedDeckValidation(player1Data, player2Data) {
        const advancedErrors = [];
        let p1DeckTotal = (player1Data?.decklist?.reduce((sum, card) => sum + card.quantity, 0) || 0) + (player1Data?.commander?.scryfall_data ? 1 : 0);
        let p2DeckTotal = (player2Data?.decklist?.reduce((sum, card) => sum + card.quantity, 0) || 0) + (player2Data?.commander?.scryfall_data ? 1 : 0);
        const deckSizeErrors = [];
        if (p1DeckTotal !== 100 && player1Data?.commander?.scryfall_data) deckSizeErrors.push(`  - Jugador 1: Mazo tiene ${p1DeckTotal} cartas.`);
        if (p2DeckTotal !== 100 && player2Data?.commander?.scryfall_data) deckSizeErrors.push(`  - Jugador 2: Mazo tiene ${p2DeckTotal} cartas.`);
        if (deckSizeErrors.length > 0) advancedErrors.push("**Violación de Regla: Mazos no tienen 100 cartas**\n" + deckSizeErrors.join("\n"));

        const commanderColorErrors = [];
        if (player1Data?.commander?.scryfall_data?.color_identity?.length > 1) commanderColorErrors.push(`  - Comandante de Jugador 1 (${player1Data.commander.name}): Identidad de color es ${player1Data.commander.scryfall_data.color_identity.join("")}, debe ser monocolor.`);
        if (player2Data?.commander?.scryfall_data?.color_identity?.length > 1) commanderColorErrors.push(`  - Comandante de Jugador 2 (${player2Data.commander.name}): Identidad de color es ${player2Data.commander.scryfall_data.color_identity.join("")}, debe ser monocolor.`);
        if (commanderColorErrors.length > 0) advancedErrors.push("**Violación de Regla: Comandantes Multi-color**\n" + commanderColorErrors.join("\n"));

        const p1NonLandCardNames = new Set();
        player1Data?.decklist?.forEach(card => { if (card.scryfall_data && !card.scryfall_data.type_line?.toLowerCase().includes("land")) p1NonLandCardNames.add(card.name.toLowerCase()); });
        const repeatedCardErrors = [];
        player2Data?.decklist?.forEach(card => { if (card.scryfall_data && !card.scryfall_data.type_line?.toLowerCase().includes("land") && p1NonLandCardNames.has(card.name.toLowerCase())) repeatedCardErrors.push(`  - '${card.name}' repetida entre mazos.`); });
        if (repeatedCardErrors.length > 0) advancedErrors.push("**Violación de Regla: Cartas no-tierra repetidas entre mazos**\n" + [...new Set(repeatedCardErrors)].join("\n"));

        const colorIdentityErrors = [];
        let combinedCommanderColors = new Set();
        player1Data?.commander?.scryfall_data?.color_identity?.forEach(color => combinedCommanderColors.add(color));
        player2Data?.commander?.scryfall_data?.color_identity?.forEach(color => combinedCommanderColors.add(color));
        const combinedColorsString = Array.from(combinedCommanderColors).join("") || "Colorless";
        [player1Data, player2Data].forEach((playerData, playerIndex) => {
            playerData?.decklist?.forEach(card => {
                if (card.scryfall_data?.color_identity) {
                    const cardColors = card.scryfall_data.color_identity;
                    let isAllowed = true;
                    if (cardColors.length > 0) {
                        if (combinedCommanderColors.size === 0) isAllowed = false;
                        else { for (const color of cardColors) if (!combinedCommanderColors.has(color)) { isAllowed = false; break; } }
                    }
                    if (!isAllowed) colorIdentityErrors.push(`  - Jugador ${playerIndex + 1} - Carta '${card.name}' (Identidad: ${cardColors.join("") || "Colorless"}) está fuera de la identidad combinada de los comandantes (${combinedColorsString}).`);
                }
            });
        });
        if (colorIdentityErrors.length > 0) advancedErrors.push("**Violación de Regla: Cartas fuera de la identidad de color combinada**\n" + colorIdentityErrors.join("\n"));

        const gameChangerErrors = [];
        [player1Data, player2Data].forEach((playerData, playerIndex) => {
            if (playerData?.decklist) {
                const gameChangerCardsInDeck = [];
                let gameChangerCount = 0;
                playerData.decklist.forEach(card => { if (card.scryfall_data?.game_changer === true) { gameChangerCount++; gameChangerCardsInDeck.push(card.name); } });
                if (playerData.commander?.scryfall_data?.game_changer === true) { gameChangerCount++; gameChangerCardsInDeck.push(`${playerData.commander.name} (Comandante)`); }
                if (gameChangerCount > 3) gameChangerErrors.push(`  - Jugador ${playerIndex + 1}: Tiene ${gameChangerCount} Game Changers (Máx. 3).\n    - Cartas: ${gameChangerCardsInDeck.join(", ")}`);
            }
        });
        if (gameChangerErrors.length > 0) advancedErrors.push("**Violación de Regla: Demasiados Game Changers**\n" + gameChangerErrors.join("\n"));
        return advancedErrors;
    }

    function generateDecklistFields(decklist, baseFieldName) {
        const fields = [];
        if (!decklist || decklist.length === 0) {
            fields.push({ name: `${baseFieldName} (0 cartas)`, value: "Ninguna carta en el mazo.", inline: false });
            return fields;
        }
        const totalQuantity = decklist.reduce((sum, card) => sum + card.quantity, 0);
        let currentFieldValue = "";
        let partCounter = 0;
        const initialFieldName = `${baseFieldName} (${totalQuantity} cartas)`;
        decklist.forEach((card) => {
            const cardLine = `${card.quantity}x ${card.name}\n`;
            if (currentFieldValue.length + cardLine.length > MAX_FIELD_VALUE_LENGTH) {
                fields.push({ name: partCounter === 0 ? initialFieldName : `${initialFieldName} (Cont. ${partCounter})`, value: currentFieldValue.trim(), inline: false });
                currentFieldValue = ""; partCounter++;
            }
            currentFieldValue += cardLine;
        });
        if (currentFieldValue.length > 0) fields.push({ name: partCounter === 0 ? initialFieldName : `${initialFieldName} (Cont. ${partCounter})`, value: currentFieldValue.trim(), inline: false });
        return fields;
    }

    function sendToDiscord(p1Data, p2Data, p1Name, p2Name) {
        const threadTitle = `${p1Name || "Jugador 1"} & ${p2Name || "Jugador 2"} - Team submission`;
        const payload = { username: "2HG Deck Registration Bot", avatar_url: "", thread_name: threadTitle, embeds: [] };

        if (p1Data && p1Data.commander) {
            const p1Embed = { title: `Jugador 1: ${p1Name || "Nombre no ingresado"}`, fields: [] };
            p1Embed.fields.push({ name: "-------------------------", value: "\u200B", inline: false });
            p1Embed.fields.push({ name: "Comandante", value: p1Data.commander.name, inline: false });
            p1Embed.fields.push({ name: "-------------------------", value: "\u200B", inline: false });
            p1Embed.fields.push(...generateDecklistFields(p1Data.decklist, "Mazo"));
            const p1ValidationErrors = [];
            if (p1Data.commander.error) p1ValidationErrors.push(`Comandante: ${p1Data.commander.error}`);
            else if (!p1Data.commander.is_legal) p1ValidationErrors.push(`Comandante: '${p1Data.commander.name}' es ILEGAL o NO ENCONTRADO.`);
            p1Data.decklist.forEach(card => { if (card.error) p1ValidationErrors.push(card.error); });
            if (p1ValidationErrors.length > 0) {
                p1Embed.fields.push({ name: "Errores de Validación P1", value: p1ValidationErrors.join("\n").substring(0, 1020), inline: false });
                p1Embed.color = 15158332; // Red
            } else p1Embed.color = 3066993; // Green
            payload.embeds.push(p1Embed);
        }

        if (p2Data && p2Data.commander) {
            const p2Embed = { title: `Jugador 2: ${p2Name || "Nombre no ingresado"}`, fields: [] };
            p2Embed.fields.push({ name: "-------------------------", value: "\u200B", inline: false });
            p2Embed.fields.push({ name: "Comandante", value: p2Data.commander.name, inline: false });
            p2Embed.fields.push({ name: "-------------------------", value: "\u200B", inline: false });
            p2Embed.fields.push(...generateDecklistFields(p2Data.decklist, "Mazo"));
            const p2ValidationErrors = [];
            if (p2Data.commander.error) p2ValidationErrors.push(`Comandante: ${p2Data.commander.error}`);
            else if (!p2Data.commander.is_legal) p2ValidationErrors.push(`Comandante: '${p2Data.commander.name}' es ILEGAL o NO ENCONTRADO.`);
            p2Data.decklist.forEach(card => { if (card.error) p2ValidationErrors.push(card.error); });
            if (p2ValidationErrors.length > 0) {
                p2Embed.fields.push({ name: "Errores de Validación P2", value: p2ValidationErrors.join("\n").substring(0, 1020), inline: false });
                p2Embed.color = 15158332; // Red
            } else p2Embed.color = 3066993; // Green
            payload.embeds.push(p2Embed);
        }

        if (payload.embeds.length === 0) return Promise.resolve();
        return $.ajax({ type: "POST", url: DISCORD_WEBHOOK_URL, contentType: "application/json", data: JSON.stringify(payload) });
    }

    function clearLog() {
        $errorList.empty();
        $errorTitle.hide();
        $logWrapper.find(".faq-cont").removeClass("is-open").find(".faq-a").hide();
    }

    function displayLogMessage(messages, title, color, isError) {
        clearLog();
        if (messages.length === 0 && !isError) { // Only show success if there are messages or it's explicitly not an error
             messages.push("¡Operación completada con éxito!"); // Default success if no specific messages
        }

        messages.forEach(msg => {
            let formattedMsg = msg.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
            $errorList.append(`<div>${formattedMsg}</div>`);
        });

        const $errorTitleSvg = $errorTitle.find("svg.faq-icon").detach();
        $errorTitle.text(title).css("color", color);
        if ($errorTitleSvg.length) $errorTitle.append($errorTitleSvg);
        $errorTitle.show();

        if (!$logWrapper.find(".faq-cont .faq").hasClass("is-open")) {
            $logWrapper.find(".faq-cont .faq").show().addClass("is-open").closest(".faq-cont").find(".faq-a").slideDown(200);
        }
    }

    function startButtonLoadingAnimation($button, baseText, intervalVariable) {
        let dotCount = 0;
        if (intervalVariable === "validation") {
            if (validationDotAnimationInterval) clearInterval(validationDotAnimationInterval);
            $button.text(baseText);
            validationDotAnimationInterval = setInterval(() => {
                dotCount = (dotCount + 1) % 4;
                let dots = Array(dotCount + 1).join(".");
                $button.text(baseText + dots);
            }, 500);
        } else if (intervalVariable === "send") {
            if (sendDotAnimationInterval) clearInterval(sendDotAnimationInterval);
            $button.val(baseText);
             sendDotAnimationInterval = setInterval(() => {
                dotCount = (dotCount + 1) % 4;
                let dots = Array(dotCount + 1).join(".");
                $button.val(baseText + dots);
            }, 500);
        }
    }

    function stopButtonLoadingAnimation($button, originalText, intervalVariable) {
        if (intervalVariable === "validation") {
            clearInterval(validationDotAnimationInterval);
            validationDotAnimationInterval = null;
            $button.text(originalText);
        } else if (intervalVariable === "send") {
            clearInterval(sendDotAnimationInterval);
            sendDotAnimationInterval = null;
            $button.val(originalText);
        }
        $button.removeClass("loading-active").prop("disabled", false);
    }


    function handleDeckValidation() {
        if (validationRequestInProgress) {
            console.warn("Validation already in progress.");
            return;
        }
        validationRequestInProgress = true;
        decksAreValid = false;
        validatedDeckData = null;
        $sendButton.prop("disabled", true);
        $validateButton.prop("disabled", true).addClass("loading-active");
        startButtonLoadingAnimation($validateButton, "Validando", "validation");
        clearLog();

        Promise.all([
            validatePlayerDeck("jugador-1-comandante", "jugador-1-mazo"),
            validatePlayerDeck("jugador-2-comandante", "jugador-2-mazo")
        ])
        .then(([player1Result, player2Result]) => {
            const allErrors = [];
            if (player1Result.errors && player1Result.errors.length > 0) player1Result.errors.forEach(err => allErrors.push(`Jugador 1: ${err}`));
            if (player2Result.errors && player2Result.errors.length > 0) player2Result.errors.forEach(err => allErrors.push(`Jugador 2: ${err}`));

            if (ENABLE_ADVANCED_RULES) {
                if (player1Result?.commander?.scryfall_data && player2Result?.commander?.scryfall_data) {
                    const advancedRuleErrors = performAdvancedDeckValidation(player1Result, player2Result);
                    if (advancedRuleErrors.length > 0) advancedRuleErrors.forEach(advErr => allErrors.push(advErr));
                } else {
                    allErrors.push("No se pudieron ejecutar las reglas avanzadas porque la información de uno o ambos comandantes no está disponible.");
                }
            }

            if (allErrors.length > 0) {
                displayLogMessage(allErrors, "Oops! Hay algunos errores", "#f45d5d", true);
                localStorage.removeItem("validatedDecks");
            } else {
                decksAreValid = true;
                validatedDeckData = { player1: player1Result, player2: player2Result };
                try {
                    localStorage.setItem("validatedDecks", JSON.stringify(validatedDeckData));
                    displayLogMessage(["¡Mazos validados y guardados correctamente!"], "Validación Exitosa", "green", false);
                    $sendButton.prop("disabled", false);
                } catch (e) {
                    console.error("Error saving to localStorage:", e);
                    displayLogMessage([`Error al guardar en localStorage: ${e.message}`], "Oops! Hay algunos errores", "#f45d5d", true);
                    decksAreValid = false;
                    validatedDeckData = null;
                }
            }
        })
        .catch(error => {
            console.error("Critical error during validation process:", error);
            displayLogMessage([`Error crítico durante la validación: ${error.message || error}`], "Oops! Error Crítico", "#f45d5d", true);
            localStorage.removeItem("validatedDecks");
        })
        .finally(() => {
            validationRequestInProgress = false;
            stopButtonLoadingAnimation($validateButton, originalValidateButtonText, "validation");
        });
    }

    $validateButton.on("click", function() {
        handleDeckValidation();
    });

    $sendButton.on("click", function(event) {
        event.preventDefault();
        if (sendRequestInProgress) {
            console.warn("Send already in progress.");
            return;
        }
        if (!decksAreValid || !validatedDeckData) {
            displayLogMessage(["Por favor, valide los mazos primero."], "Error de Envío", "#f45d5d", true);
            return;
        }

        sendRequestInProgress = true;
        $sendButton.prop("disabled", true).addClass("loading-active");
        startButtonLoadingAnimation($sendButton, "Enviando", "send");
        clearLog();

        const player1Name = getElementValue("jugador-1-nombre");
        const player2Name = getElementValue("jugador-2-nombre");

        sendToDiscord(validatedDeckData.player1, validatedDeckData.player2, player1Name, player2Name)
            .then(() => {
                displayLogMessage(["Datos enviados a Discord con éxito."], "Envío Exitoso", "green", false);
                // Optionally reset state after successful send
                // decksAreValid = false;
                // validatedDeckData = null;
                // $sendButton.prop("disabled", true);
                // localStorage.removeItem("validatedDecks");
            })
            .catch((xhr, status, error) => {
                console.error("Error sending data to Discord:", status, error, xhr.responseText);
                displayLogMessage(["Error al enviar datos a Discord. La validación local fue exitosa."], "Error de Envío", "orange", true);
            })
            .always(() => { // Use .always for jQuery older versions, or .finally for modern Promises
                sendRequestInProgress = false;
                stopButtonLoadingAnimation($sendButton, originalSendButtonText, "send");
                 // Keep send button enabled if validation was successful, or disable if we want re-validation after send.
                 // For now, keep it enabled unless inputs change.
                if (!decksAreValid) { // If for some reason it became invalid during send (should not happen)
                    $sendButton.prop("disabled", true);
                }
            });
    });

    // Event listeners for input changes
    const watchedInputs = [
        "#jugador-1-comandante", "#jugador-1-mazo",
        "#jugador-2-comandante", "#jugador-2-mazo",
        // Also consider player name inputs if they should invalidate
        // "#jugador-1-nombre", "#jugador-2-nombre"
    ];

    $(watchedInputs.join(", ")).on("input", function() {
        if (decksAreValid) {
            console.log("Input changed, invalidating previous validation.");
            decksAreValid = false;
            validatedDeckData = null;
            $sendButton.prop("disabled", true);
            localStorage.removeItem("validatedDecks");
            // Optionally clear the log or add a message
            // displayLogMessage(["Los datos del mazo han cambiado. Por favor, revalide."], "Atención", "orange", true);
             $errorList.empty();
             $errorTitle.text("Los datos han cambiado, por favor revalide.").css("color", "orange").show();
             if (!$logWrapper.find(".faq-cont .faq").hasClass("is-open")) {
                $logWrapper.find(".faq-cont .faq").show().addClass("is-open").closest(".faq-cont").find(".faq-a").slideDown(200);
            }
        }
    });

});
