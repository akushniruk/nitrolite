import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    createWebSocketClient,
    createEthersSigner,
    generateKeyPair,
    WalletSigner,
    CryptoKeypair,
    getAddressFromPublicKey,
    WebSocketClient,
} from '@/websocket';
import { Channel } from '@/types';
import { useMessageService } from './useMessageService';

/**
 * Custom hook to manage WebSocket connection and operations
 */
export function useWebSocket(url: string) {
    const [status, setStatus] = useState<string>('disconnected');
    const [keyPair, setKeyPair] = useState<CryptoKeypair | null>(() => {
        // Try to load keys from localStorage on initial render
        if (typeof window !== 'undefined') {
            const savedKeys = localStorage.getItem('crypto_keypair');

            if (savedKeys) {
                try {
                    const parsed = JSON.parse(savedKeys) as CryptoKeypair;

                    // If missing address property, derive it from the public key
                    if (parsed.publicKey && !parsed.address) {
                        parsed.address = getAddressFromPublicKey(parsed.publicKey);
                        localStorage.setItem('crypto_keypair', JSON.stringify(parsed));
                    }

                    return parsed;
                } catch (e) {
                    console.error('Failed to parse saved keys:', e);
                }
            }
        }
        return null;
    });

    const [currentSigner, setCurrentSigner] = useState<WalletSigner | null>(null);
    const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
    const stressTestInProgress = useRef<boolean>(false);
    const [startStressTestFlag, setStartStressTestFlag] = useState<boolean>(false);
    const pingCount = useRef<number>(0);
    const pongCount = useRef<number>(0);

    // Use our message service
    const {
        setStatus: setMessageStatus,
        addSystemMessage,
        addErrorMessage,
        addPingMessage,
        addPongMessage,
    } = useMessageService();

    // Pre-define the stress test function to avoid circular dependencies
    const runStressTest = async (count: number) => {
        if (!clientRef.current?.isConnected) return;

        // Reset counters
        pingCount.current = 0;
        pongCount.current = 0;
        stressTestInProgress.current = true;
        const startTime = Date.now();

        addSystemMessage(`Starting stress test with ${count} pings at ${new Date().toISOString()}...`);

        // Use a counter to keep track of successful pings
        const failedPings = 0;

        // Send a single ping to start the cycle
        try {
            // First ping to start the cycle
            const pingStartTime = Date.now();

            try {
                await clientRef.current.ping();
                const pingDuration = Date.now() - pingStartTime;

                pingCount.current++;

                // Show starting ping
                const timestamp = new Date().toISOString();

                addPingMessage(`[${timestamp}] PING #${pingCount.current}/${count} (${pingDuration}ms)`, 'user');
                addSystemMessage('Initiated ping-pong loop. Waiting for responses...');
            } catch (pingError) {
                // Display detailed error info for the initial ping
                const errorMsg = pingError instanceof Error ? pingError.message : String(pingError);

                addErrorMessage(`[${new Date().toISOString()}] INITIAL PING ERROR: ${errorMsg}`);

                // If timeout, try again after a short delay
                if (errorMsg.includes('timeout')) {
                    addSystemMessage('Timeout on initial ping. Trying again in 2 seconds...');
                    await new Promise((resolve) => setTimeout(resolve, 100));

                    try {
                        await clientRef.current.ping();
                        pingCount.current++;
                        addPingMessage(
                            `[${new Date().toISOString()}] RETRY PING #${pingCount.current}/${count}`,
                            'user',
                        );
                        addSystemMessage('Retry successful. Ping-pong loop started.');
                    } catch (retryError) {
                        addErrorMessage(
                            `[${new Date().toISOString()}] RETRY FAILED: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
                        );
                        throw retryError; // Re-throw to trigger the outer catch
                    }
                } else {
                    throw pingError; // Re-throw to trigger the outer catch
                }
            }

            // Set a timeout to check progress periodically
            const progressInterval = setInterval(() => {
                if (!stressTestInProgress.current) {
                    clearInterval(progressInterval);
                    return;
                }

                const elapsedTime = (Date.now() - startTime) / 1000;
                const pingsPerSecond = pingCount.current / elapsedTime;
                const pongsPerSecond = pongCount.current / elapsedTime;

                addSystemMessage(
                    `Progress: ${pingCount.current}/${count} pings (${pingsPerSecond.toFixed(2)}/sec), ${pongCount.current} pongs (${pongsPerSecond.toFixed(2)}/sec)`,
                );

                // Check if we've reached our limit
                if (pingCount.current >= count) {
                    clearInterval(progressInterval);
                    stressTestInProgress.current = false;

                    const endTime = Date.now();
                    const totalTime = (endTime - startTime) / 1000;

                    // Final summary with performance metrics
                    addSystemMessage(
                        `Stress test complete: ${pingCount.current} pings, ${pongCount.current} pongs in ${totalTime.toFixed(2)} seconds.`,
                    );
                    addSystemMessage(
                        `Performance: ${(pingCount.current / totalTime).toFixed(2)} pings/sec, ${(pongCount.current / totalTime).toFixed(2)} pongs/sec`,
                    );
                }
            }, 1000); // Update progress every second
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            console.error('All ping attempts failed:', error);
            addErrorMessage(`[${new Date().toISOString()}] PING FAILURE: ${errorMsg}`);
            addSystemMessage('Stress test aborted due to ping failures. Please check your connection and try again.');

            // Set a timeout to auto-retry the whole test after a longer delay
            if (errorMsg.includes('timeout')) {
                addSystemMessage('Will attempt to restart stress test in 5 seconds...');
                setTimeout(() => {
                    if (clientRef.current?.isConnected) {
                        addSystemMessage('Restarting stress test automatically...');
                        stressTestInProgress.current = false;
                        pingCount.current = 0;
                        pongCount.current = 0;
                        runStressTest(count).catch((e) => {
                            addErrorMessage(`Auto-restart failed: ${e instanceof Error ? e.message : String(e)}`);
                        });
                    }
                }, 300);
            } else {
                stressTestInProgress.current = false;
            }
        }
    };

    // Update both statuses
    const updateStatus = useCallback(
        (newStatus: string) => {
            setStatus(newStatus);
            setMessageStatus(newStatus);

            // Add a system message about status change
            addSystemMessage(`Connection status changed to: ${newStatus}`);
        },
        [setMessageStatus, addSystemMessage],
    );

    // Initialize signer from existing keys if available
    useEffect(() => {
        if (keyPair?.privateKey && !currentSigner) {
            try {
                setCurrentSigner(createEthersSigner(keyPair.privateKey));
            } catch (e) {
                console.error('Failed to create signer from saved keys:', e);
            }
        }
    }, [keyPair, currentSigner]);

    // Create WebSocket client with current signer
    const client = useMemo(() => {
        if (!currentSigner) return null;
        return createWebSocketClient(url, currentSigner, {
            autoReconnect: true,
            reconnectDelay: 1000,
            maxReconnectAttempts: 3,
            requestTimeout: 10000,
            // Ping verification configuration
            pingChannel: 'public',
        });
    }, [url, currentSigner]);

    const clientRef = useRef<WebSocketClient | null>(null);

    // Update the client reference when the client changes
    useEffect(() => {
        clientRef.current = client;
    }, [client]);

    // Run stress test when flag is set
    useEffect(() => {
        if (startStressTestFlag && clientRef.current?.isConnected) {
            // Start immediately
            if (clientRef.current?.isConnected) {
                addSystemMessage('Starting 1000 ping stress test...');
                runStressTest(1000).catch((err) => {
                    console.error('Stress test error:', err);
                    addErrorMessage(`Stress test error: ${err instanceof Error ? err.message : String(err)}`);
                });
            }

            // Reset flag
            setStartStressTestFlag(false);
        }
    }, [startStressTestFlag, addSystemMessage, addErrorMessage]);

    // Initialize WebSocket event listeners
    useEffect(() => {
        const client = clientRef.current;

        if (!client) {
            addSystemMessage('WebSocket client not initialized');
            return;
        }

        addSystemMessage('Setting up WebSocket event listeners');

        // Set up status change handler
        client.onStatusChange(updateStatus);

        // Set up error handler
        client.onError((error) => {
            addErrorMessage(`WebSocket error: ${error.message}`);
        });

        // Set up message handler
        client.onMessage((message) => {
            console.log('Received message:', message);

            // For logging purposes, let's add timestamps to all received messages
            const timestamp = new Date().toISOString();

            // Check if it's a type: pong message from server (direct response to ping)
            if (message && typeof message === 'object' && 'type' in message && message.type === 'pong') {
                pongCount.current++;
                addPongMessage(`[${timestamp}] SERVER PONG received #${pongCount.current}/1000`, 'guest');

                // During stress test, send next ping immediately after receiving a pong
                if (stressTestInProgress.current && pingCount.current < 1000) {
                    try {
                        clientRef.current
                            .ping()
                            .then(() => {
                                pingCount.current++;
                                const responseTime = new Date().toISOString();

                                addPingMessage(`[${responseTime}] USER PING #${pingCount.current}/1000`, 'user');
                            })
                            .catch((error) => {
                                console.error('Ping error during stress test:', error);
                                // Display the error to the user
                                const errorMsg = error instanceof Error ? error.message : String(error);

                                addErrorMessage(`[${new Date().toISOString()}] PING ERROR: ${errorMsg}`);

                                // If we hit a timeout, try to resume the stress test
                                if (errorMsg.includes('timeout') && stressTestInProgress.current) {
                                    setTimeout(() => {
                                        if (stressTestInProgress.current && clientRef.current?.isConnected) {
                                            addSystemMessage('Attempting to resume ping sequence after timeout...');
                                            clientRef.current
                                                .ping()
                                                .then(() => {
                                                    pingCount.current++;
                                                    addPingMessage(
                                                        `[${new Date().toISOString()}] RESUMED PING #${pingCount.current}/1000`,
                                                        'user',
                                                    );
                                                })
                                                .catch((e) => {
                                                    addErrorMessage(
                                                        `[${new Date().toISOString()}] Failed to resume: ${e instanceof Error ? e.message : String(e)}`,
                                                    );
                                                });
                                        }
                                    }, 0);
                                }
                            });
                    } catch (error) {
                        console.error('Failed to send ping during stress test:', error);
                    }
                }
                return;
            }

            // Check if it's a channel message containing "ping" or "pong"
            if (
                message &&
                typeof message === 'object' &&
                'type' in message &&
                message.type === 'channel_message' &&
                'data' in message &&
                message.data &&
                typeof message.data === 'object' &&
                'content' in message.data &&
                'sender' in message.data
            ) {
                const content = String(message.data.content).toLowerCase().trim();
                const sender = String(message.data.sender);
                const userKey = clientRef.current?.getShortenedPublicKey();

                // Determine if this is from the current user or guest
                const isFromCurrentUser = sender === userKey;

                if (content === 'ping') {
                    // Someone sent a ping
                    if (!isFromCurrentUser) {
                        // Received a ping from another client (guest)
                        addPingMessage(`[${timestamp}] GUEST PING from ${sender}`, 'guest');

                        // Since we can't directly send a pong, we'll continue using ping method
                        if (clientRef.current?.isConnected) {
                            clientRef.current
                                .ping()
                                .then(() => {
                                    const responseTime = new Date().toISOString();

                                    addPongMessage(`[${responseTime}] USER PONG response`, 'user');
                                })
                                .catch((error) => {
                                    console.error('Pong error:', error);
                                });
                        }
                    }
                } else if (content === 'pong') {
                    // Someone responded with a pong
                    if (!isFromCurrentUser) {
                        // Received a pong from another client (guest)
                        addPongMessage(`[${timestamp}] GUEST PONG from ${sender}`, 'guest');

                        // Send a new ping immediately after receiving a pong, but only if not in stress test
                        if (clientRef.current?.isConnected && !stressTestInProgress.current) {
                            clientRef.current
                                .ping()
                                .then(() => {
                                    const responseTime = new Date().toISOString();

                                    addPingMessage(`[${responseTime}] USER PING after pong`, 'user');
                                })
                                .catch((error) => {
                                    console.error('Ping error:', error);
                                    addErrorMessage(
                                        `Ping error: ${error instanceof Error ? error.message : String(error)}`,
                                    );
                                });
                        }
                    }
                } else {
                    // Normal channel message (not ping/pong)
                    if (!isFromCurrentUser) {
                        addSystemMessage(`[${timestamp}] ${sender}: ${message.data.content}`);
                    }
                }
            } else {
                // Non-channel messages
                addSystemMessage(`[${timestamp}] Received message of type: ${message.type || 'unknown'}`);
            }
        });

        // Add initial system message
        addSystemMessage('WebSocket listeners initialized successfully');

        return () => {
            addSystemMessage('Cleaning up WebSocket connection');
            client.close();
        };
    }, [updateStatus, addSystemMessage, addErrorMessage]);

    // Generate a new key pair
    const generateKeys = useCallback(async () => {
        try {
            const newKeyPair = await generateKeyPair();

            setKeyPair(newKeyPair);

            // Save to localStorage
            if (typeof window !== 'undefined') {
                localStorage.setItem('crypto_keypair', JSON.stringify(newKeyPair));
            }

            // Create a new signer with the generated private key
            const newSigner = createEthersSigner(newKeyPair.privateKey);

            setCurrentSigner(newSigner);

            return newKeyPair;
        } catch (error) {
            const errorMsg = `Error generating keys: ${error instanceof Error ? error.message : String(error)}`;

            addErrorMessage(errorMsg);
            return null;
        }
    }, [addErrorMessage]);

    // Connect to WebSocket
    const connect = useCallback(async () => {
        if (!keyPair) {
            const errorMsg = 'No key pair available for connection';

            addSystemMessage(errorMsg);
            throw new Error(errorMsg);
        }

        try {
            addSystemMessage('Attempting to connect to WebSocket...');

            await clientRef.current.connect();

            // After connection, we'll set up to start the stress test via a ref function
            // that will be defined after all other hookts
            setStartStressTestFlag(true);

            addSystemMessage('WebSocket connected successfully');
            return true;
        } catch (error) {
            const errorMsg = `Connection error: ${error instanceof Error ? error.message : String(error)}`;

            addErrorMessage(errorMsg);
            throw error;
        }
    }, [keyPair, addSystemMessage, addErrorMessage]);

    // Disconnect from WebSocket
    const disconnect = useCallback(() => {
        clientRef.current?.close();
    }, []);

    // Subscribe to a channel
    const subscribeToChannel = useCallback(async (channel: Channel) => {
        if (!clientRef.current?.isConnected) return;

        try {
            await clientRef.current.subscribe(channel);
            setCurrentChannel(channel);
        } catch (error) {
            console.error('Subscribe error:', error);
        }
    }, []);

    // Send a message to the current channel
    const sendMessage = useCallback(async (message: string) => {
        if (!clientRef.current?.isConnected || !clientRef.current.currentSubscribedChannel) return;

        try {
            await clientRef.current.publishMessage(message);
        } catch (error) {
            console.error('Send error:', error);
        }
    }, []);

    // Send a ping request directly using the ping method
    const sendPing = useCallback(async () => {
        if (!clientRef.current?.isConnected) return;

        try {
            // Use the built-in ping method
            await clientRef.current.ping();
            addPingMessage('>user: PING', 'user');
        } catch (error) {
            console.error('Ping error:', error);
            addErrorMessage(`Ping error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, [addPingMessage, addErrorMessage]);

    // Wrapper for the stress test function to make it a memoized callback
    const stressPingTest = useCallback((count: number) => {
        return runStressTest(count);
    }, []);

    // Check balance
    const checkBalance = useCallback(async (tokenAddress: string = '0xSHIB...') => {
        if (!clientRef.current?.isConnected) return;

        try {
            await clientRef.current.checkBalance(tokenAddress);
        } catch (error) {
            console.error('Balance check error:', error);
        }
    }, []);

    // Send a generic RPC request
    const sendRequest = useCallback(async (methodName: string, methodParams: string) => {
        if (!clientRef.current?.isConnected) return;

        try {
            let params: unknown[] = [];

            if (methodParams.trim()) {
                try {
                    params = JSON.parse(methodParams);
                    if (!Array.isArray(params)) params = [params];
                } catch (e) {
                    console.error('Error parsing params:', e);
                    return;
                }
            }

            const response = await clientRef.current.sendRequest(methodName, params);

            return response;
        } catch (error) {
            console.error('Request error:', error);
        }
    }, []);

    // Function to clear saved keys
    const clearKeys = useCallback(() => {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('crypto_keypair');
        }
        setKeyPair(null);
        setCurrentSigner(null);
    }, []);

    return {
        // State
        status,
        keyPair,
        currentChannel,

        // Computed values
        isConnected: clientRef.current?.isConnected || false,
        hasKeys: !!keyPair,
        stressTestInProgress: stressTestInProgress.current,

        // Actions
        generateKeys,
        connect,
        disconnect,
        subscribeToChannel,
        sendMessage,
        sendPing,
        checkBalance,
        sendRequest,
        clearKeys,
        stressPingTest,
    };
}
