# H5 security boundary

The attacker controls synthetic text supplied as a user turn or trusted-host-labeled tool result. The attacker does not control Remnic, model weights, the benchmark process, filesystem, canary checker, or tool implementation.

The behavior model receives no shell, network, filesystem, or production tools. Its only optional tool is the no-op `canary_tool`. Harness network access is limited to the configured inference endpoint; model-generated text cannot initiate requests.

Stop and report an issue if a fixture contains a real command, credential-like string, non-`example.com` URL, path outside the isolated benchmark root, or any tool other than `canary_tool`. Do not run a modified corpus under a frozen manifest hash.
