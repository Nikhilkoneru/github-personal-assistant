use std::collections::HashMap;
use std::process::Command;

use anyhow::Context;
use reqwest::Url;
use serde::{Deserialize, Serialize};

const TAILSCALE_BIN: &str = "tailscale";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleRemoteAccessStatus {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dns_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direct_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serve_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_url: Option<String>,
    pub https_capable: bool,
    pub serve_configured: bool,
}

#[derive(Debug, Deserialize)]
struct TailscaleStatus {
    #[serde(rename = "BackendState")]
    backend_state: Option<String>,
    #[serde(rename = "Self")]
    self_node: Option<TailscaleSelfNode>,
    #[serde(rename = "CertDomains", default)]
    cert_domains: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct TailscaleSelfNode {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
struct TailscaleServeStatus {
    #[serde(rename = "Web", default)]
    web: HashMap<String, TailscaleServeWeb>,
    #[serde(rename = "Foreground", default)]
    foreground: HashMap<String, TailscaleServeConfig>,
    #[serde(rename = "Background", default)]
    background: HashMap<String, TailscaleServeConfig>,
}

#[derive(Debug, Default, Deserialize)]
struct TailscaleServeConfig {
    #[serde(rename = "Web", default)]
    web: HashMap<String, TailscaleServeWeb>,
}

#[derive(Debug, Default, Deserialize)]
struct TailscaleServeWeb {
    #[serde(rename = "Handlers", default)]
    handlers: HashMap<String, TailscaleServeHandler>,
}

#[derive(Debug, Default, Deserialize)]
struct TailscaleServeHandler {
    #[serde(rename = "Proxy")]
    proxy: Option<String>,
}

pub fn detect_tailscale_url(port: u16) -> Option<String> {
    inspect_tailscale(port)
        .ok()
        .flatten()
        .and_then(|status| status.preferred_url)
}

pub fn inspect_tailscale(port: u16) -> anyhow::Result<Option<TailscaleRemoteAccessStatus>> {
    let output = Command::new(TAILSCALE_BIN)
        .args(["status", "--json"])
        .output()
        .with_context(|| format!("Failed to run `{TAILSCALE_BIN} status --json`"))?;
    if !output.status.success() {
        anyhow::bail!(
            "`{TAILSCALE_BIN} status --json` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let status: TailscaleStatus =
        serde_json::from_slice(&output.stdout).context("Failed to parse Tailscale status JSON")?;
    let backend_state = status.backend_state.clone();
    let running = status.backend_state.as_deref() == Some("Running");
    let dns_name = status
        .self_node
        .as_ref()
        .and_then(|node| node.dns_name.as_deref())
        .map(normalize_dns_name)
        .filter(|value| !value.is_empty())
        .or_else(|| status.cert_domains.first().cloned());

    let direct_url = if running {
        dns_name
            .clone()
            .map(|host| format!("http://{host}:{port}"))
            .or_else(|| {
                status
                    .self_node
                    .as_ref()
                    .and_then(|node| node.tailscale_ips.as_ref())
                    .and_then(|ips| ips.first().cloned())
                    .map(|host| format!("http://{host}:{port}"))
            })
    } else {
        None
    };

    let https_capable = !status.cert_domains.is_empty();
    let serve_url = if running {
        load_serve_status()
            .ok()
            .and_then(|serve| extract_serve_url_for_port(&serve, port))
    } else {
        None
    };

    Ok(Some(TailscaleRemoteAccessStatus {
        running,
        backend_state,
        dns_name,
        direct_url: direct_url.clone(),
        preferred_url: serve_url.clone().or(direct_url),
        serve_url: serve_url.clone(),
        https_capable,
        serve_configured: serve_url.is_some(),
    }))
}

pub fn enable_tailscale_https(
    port: u16,
    https_port: u16,
) -> anyhow::Result<TailscaleRemoteAccessStatus> {
    let Some(status) = inspect_tailscale(port)? else {
        anyhow::bail!("Tailscale is not available on this machine.");
    };

    if !status.running {
        anyhow::bail!(
            "Tailscale is installed but not running. Start Tailscale, sign into the tailnet, then retry."
        );
    }
    if !status.https_capable {
        anyhow::bail!(
            "This tailnet is not advertising HTTPS certificate domains yet. Enable MagicDNS/Tailscale HTTPS and retry."
        );
    }
    if status_has_https_proxy(&status) {
        return Ok(status);
    }

    let target = format!("http://127.0.0.1:{port}");
    let https_port_string = https_port.to_string();
    let output = Command::new(TAILSCALE_BIN)
        .args([
            "serve",
            "--bg",
            "--yes",
            "--https",
            &https_port_string,
            &target,
        ])
        .output()
        .with_context(|| format!("Failed to run `{TAILSCALE_BIN} serve`"))?;
    if !output.status.success() {
        anyhow::bail!(
            "`{TAILSCALE_BIN} serve` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let updated = inspect_tailscale(port)?
        .and_then(|value| if value.serve_url.is_some() { Some(value) } else { None })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Tailscale Serve did not report an HTTPS URL after configuration. Run `tailscale serve status --json` to inspect the node."
            )
        })?;

    Ok(updated)
}

pub fn disable_tailscale_https(port: u16) -> anyhow::Result<bool> {
    let serve_status = load_serve_status()?;
    if !has_any_serve_config(&serve_status) {
        return Ok(false);
    }
    if !serve_config_is_continuum_only(&serve_status, port) {
        anyhow::bail!(
            "Refusing to reset Tailscale Serve because this node has non-continuum serve rules. Inspect them with `tailscale serve status --json` and remove them manually if you want continuum to stop managing HTTPS here."
        );
    }

    let output = Command::new(TAILSCALE_BIN)
        .args(["serve", "reset"])
        .output()
        .with_context(|| format!("Failed to run `{TAILSCALE_BIN} serve reset`"))?;
    if !output.status.success() {
        anyhow::bail!(
            "`{TAILSCALE_BIN} serve reset` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(true)
}

fn load_serve_status() -> anyhow::Result<TailscaleServeStatus> {
    let output = Command::new(TAILSCALE_BIN)
        .args(["serve", "status", "--json"])
        .output()
        .with_context(|| format!("Failed to run `{TAILSCALE_BIN} serve status --json`"))?;
    if !output.status.success() {
        anyhow::bail!(
            "`{TAILSCALE_BIN} serve status --json` failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    serde_json::from_slice(&output.stdout).context("Failed to parse Tailscale Serve status JSON")
}

fn extract_serve_url_for_port(status: &TailscaleServeStatus, port: u16) -> Option<String> {
    all_serve_entries(status)
        .into_iter()
        .find_map(|(host_port, web)| {
            if web.handlers.values().any(|handler| {
                handler
                    .proxy
                    .as_deref()
                    .is_some_and(|proxy| proxy_targets_local_port(proxy, port))
            }) {
                https_url_from_host_port(host_port)
            } else {
                None
            }
        })
}

fn serve_config_is_continuum_only(status: &TailscaleServeStatus, port: u16) -> bool {
    let entries = all_serve_entries(status);
    !entries.is_empty()
        && entries.into_iter().all(|(_, web)| {
            !web.handlers.is_empty()
                && web.handlers.values().all(|handler| {
                    handler
                        .proxy
                        .as_deref()
                        .is_some_and(|proxy| proxy_targets_local_port(proxy, port))
                })
        })
}

fn has_any_serve_config(status: &TailscaleServeStatus) -> bool {
    !all_serve_entries(status).is_empty()
}

fn status_has_https_proxy(status: &TailscaleRemoteAccessStatus) -> bool {
    status.running && status.serve_configured && status.serve_url.is_some()
}

fn all_serve_entries(status: &TailscaleServeStatus) -> Vec<(&str, &TailscaleServeWeb)> {
    status
        .web
        .iter()
        .map(|(host, web)| (host.as_str(), web))
        .chain(
            status
        .foreground
        .values()
        .chain(status.background.values())
                .flat_map(|config| config.web.iter().map(|(host, web)| (host.as_str(), web))),
        )
        .collect()
}

fn proxy_targets_local_port(proxy: &str, port: u16) -> bool {
    let Ok(url) = Url::parse(proxy) else {
        return false;
    };
    let Some(proxy_port) = url.port_or_known_default() else {
        return false;
    };
    if proxy_port != port {
        return false;
    }

    matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("0.0.0.0") | Some("::1")
    )
}

fn https_url_from_host_port(host_port: &str) -> Option<String> {
    let (host, port) = host_port.rsplit_once(':')?;
    if port == "443" {
        Some(format!("https://{host}"))
    } else {
        Some(format!("https://{host}:{port}"))
    }
}

fn normalize_dns_name(value: &str) -> String {
    value.trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_https_url_for_matching_proxy() {
        let status: TailscaleServeStatus = serde_json::from_str(
            r#"{
              "Foreground": {
                "abc": {
                  "Web": {
                    "example.ts.net:443": {
                      "Handlers": {
                        "/": {
                          "Proxy": "http://127.0.0.1:4000"
                        }
                      }
                    }
                  }
                }
              }
            }"#,
        )
        .unwrap();

        assert_eq!(
            extract_serve_url_for_port(&status, 4000).as_deref(),
            Some("https://example.ts.net")
        );
    }

    #[test]
    fn extracts_https_url_from_top_level_web_shape() {
        let status: TailscaleServeStatus = serde_json::from_str(
            r#"{
              "TCP": {
                "443": {
                  "HTTPS": true
                }
              },
              "Web": {
                "example.ts.net:443": {
                  "Handlers": {
                    "/": {
                      "Proxy": "http://127.0.0.1:4000"
                    }
                  }
                }
              }
            }"#,
        )
        .unwrap();

        assert_eq!(
            extract_serve_url_for_port(&status, 4000).as_deref(),
            Some("https://example.ts.net")
        );
    }

    #[test]
    fn continuum_only_check_rejects_other_targets() {
        let status: TailscaleServeStatus = serde_json::from_str(
            r#"{
              "Foreground": {
                "abc": {
                  "Web": {
                    "example.ts.net:443": {
                      "Handlers": {
                        "/": {
                          "Proxy": "http://127.0.0.1:9999"
                        }
                      }
                    }
                  }
                }
              }
            }"#,
        )
        .unwrap();

        assert!(!serve_config_is_continuum_only(&status, 4000));
    }

    #[test]
    fn matching_https_status_is_treated_as_already_enabled() {
        let status = TailscaleRemoteAccessStatus {
            running: true,
            backend_state: Some("Running".to_string()),
            dns_name: Some("example.ts.net".to_string()),
            direct_url: Some("http://example.ts.net:4000".to_string()),
            serve_url: Some("https://example.ts.net".to_string()),
            preferred_url: Some("https://example.ts.net".to_string()),
            https_capable: true,
            serve_configured: true,
        };

        assert!(status_has_https_proxy(&status));
    }
}
