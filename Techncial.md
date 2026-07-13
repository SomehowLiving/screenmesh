Build a **transport-independent cross-device layer**:

> Notes, clipboard items, screenshots, files, and commands move between devices using whichever path is currently available—and remain queued when no path exists.

The application should treat Bluetooth, Wi-Fi, WebRTC, QR, audio, and future protocols as interchangeable transports.

---

# Most interesting connection approaches

## 1. Browser-to-browser local P2P without a server

A 2025 WICG proposal called **Local Peer-to-Peer API** is almost exactly what your idea needs. It proposes browser discovery, authenticated pairing, direct data channels, and QUIC-based communication over local media such as LAN, Wi-Fi Direct, BLE, or Thread.

The problem: it remains an incomplete incubator proposal, not a production browser standard. You should design around it and possibly contribute experiments, but not depend on it today. ([wicg.github.io][1])

### Why it matters

Today, WebRTC can transfer data peer-to-peer, but developers still need to solve:

* Signaling
* Discovery
* Peer authentication
* Permissions
* Local device selection

The proposal moves these responsibilities into the browser.

### Product interaction

```text
Nearby screens

▣ Nidhi's Laptop
▣ Lab Monitor
▣ Pixel Phone

Select a device → Connect
```

No room IDs, URLs, or accounts.

### Verdict

**High strategic relevance, low immediate availability.**

Build your internal abstraction to resemble this API so you can adopt it later.

---

## 2. Isolated Web Apps with raw TCP and UDP

Chrome’s **Isolated Web Apps** can use the new Direct Sockets API to:

* Open TCP connections
* Listen as a TCP server
* Send UDP packets
* Use multicast
* Perform local network discovery
* Implement custom protocols directly in JavaScript

This is one of the most interesting developments for capable desktop web applications. ([Chrome for Developers][2])

However, the initial IWA release is restricted to Chrome Enterprise-administered ChromeOS devices and selected development partners. It is not yet a general consumer replacement for PWAs. ([Chrome for Developers][3])

### Potential experiment

A laptop becomes a discoverable local endpoint:

```text
relaypad.local
UDP discovery port: 44044
QUIC/TCP sync port: 44045
```

Other devices discover it and synchronize directly.

### Verdict

**Excellent research direction, weak current distribution.**

It could eventually let you build a web-based equivalent of a native LAN application.

---

## 3. Store–carry–forward: communication without simultaneous connectivity

This is the strongest direction for your idea.

Instead of assuming both devices must be connected at the same time:

1. Every edit becomes an encrypted bundle.
2. Each device stores bundles locally.
3. Devices exchange missing bundles whenever they encounter each other.
4. A trusted device can carry a bundle toward another device.
5. The destination eventually receives it.

NASA’s Delay/Disruption Tolerant Networking uses this store-and-forward model when continuous end-to-end connectivity cannot be assumed. ([NASA][4])

Briar applies a related approach to terrestrial messaging, synchronizing directly using Bluetooth, Wi-Fi, Tor, and even removable storage. ([Google Play][5])

### Example

```text
Phone A → Laptop B: send note

Laptop B is offline.

Phone A meets Tablet C.
Tablet C accepts the encrypted delivery bundle.

Later Tablet C encounters Laptop B.
Laptop B receives the note.
```

Tablet C cannot read the note. It only carries it.

### Why this is differentiated

Most shared applications are:

```text
Device → cloud → device
```

Your system could be:

```text
Device → any available route → destination
```

That route could include:

* Direct Wi-Fi
* WebRTC
* Bluetooth
* A trusted personal relay
* USB export
* Animated QR
* Internet relay
* Another user’s device

### Verdict

**Build this.**

This is a real product architecture, not merely a connectivity demo.

---

## 4. Google Nearby Connections

Nearby Connections abstracts Bluetooth, BLE, and Wi-Fi behind a single encrypted peer-to-peer API. It handles advertising, discovery, authentication, and bytes, streams, or file transfer without requiring internet access. Google explicitly lists collaborative whiteboards, multi-screen applications, and offline file transfer as use cases. ([Google for Developers][6])

It currently has documented Android and Swift SDKs. ([Google for Developers][7])

### Good use

Create a thin native companion:

```text
PWA UI
   ↓
Native nearby bridge
   ↓
Nearby Connections
   ↓
Phone / tablet peer
```

The PWA can remain your primary interface, while the native bridge gives you better nearby transport.

### Limitation

It does not solve arbitrary Windows/Linux/browser interoperability by itself.

### Verdict

**Best practical native nearby adapter for an early Android prototype.**

---

## 5. Wi-Fi Aware / Neighbor Awareness Networking

Wi-Fi Aware allows supported Android devices to:

* Advertise services
* Discover devices nearby
* Exchange small discovery messages
* Establish bidirectional Wi-Fi connections
* Communicate without an access point or internet connection

It generally provides higher throughput and longer distance than Bluetooth. ([Android Developers][8])

### Product possibility

A phone automatically sees a nearby laptop companion:

```text
RelayPad service discovered
Distance class: nearby
Transport: Wi-Fi Aware
Internet required: no
```

### Limitation

* Android-only
* Hardware-dependent
* Native API
* Availability can conflict with hotspot, tethering, or Wi-Fi Direct usage

### Verdict

**Technically strong, distribution-limited.**

Use it as an optional high-throughput Android adapter, not the baseline.

---

## 6. Apple peer-to-peer networking

Apple’s Multipeer Connectivity framework can discover and exchange messages, streams, and files through infrastructure Wi-Fi, peer-to-peer Wi-Fi, and Bluetooth-based networking. Apple is increasingly directing lower-level networking work toward Network.framework with peer-to-peer support. ([Apple Developer][9])

### Interesting model

Build platform adapters:

```text
Android: Nearby Connections / Wi-Fi Aware
Apple: Network.framework / Multipeer Connectivity
Web: WebRTC / relay
Desktop: local daemon / IWA later
```

All adapters carry the same encrypted synchronization frames.

### Verdict

**Necessary for a polished Apple experience, but not a universal protocol.**

---

# Spatial connections: select a screen by pointing at it

## 7. UWB-based “point to send”

UWB should not carry the note itself. It should determine **which device the user intends to address**.

Apple’s Nearby Interaction and Android’s UWB APIs expose distance—and in supported scenarios, direction—to nearby devices or accessories. Android’s Core UWB library reached stable 1.0 in May 2026, although supported hardware remains limited. ([Apple Developer][10])

### Interaction

```text
1. Hold phone toward laptop.
2. Laptop becomes highlighted.
3. Swipe note upward.
4. Data transfers over Wi-Fi/WebRTC.
```

UWB performs targeting. Another transport performs transfer.

This is similar to separating:

```text
Discovery and intent → UWB
Payload transport     → Wi-Fi/WebRTC
```

### Verdict

**Very strong demo and future UX moat.**

But do it after the synchronization layer works.

---

## 8. Bluetooth Channel Sounding

Bluetooth 6 introduced Channel Sounding for more accurate and secure distance measurement. The Bluetooth SIG describes centimeter-level ranging using phase-based measurements and round-trip-time distance bounding; early implementations reportedly reach roughly ±20 cm under suitable conditions. ([Bluetooth® Technology Website][11])

This could eventually provide UWB-like proximity experiences on more devices.

### Possible feature

```text
Move phone close to screen → screen becomes transfer target

Within 30 cm:
“Drop clipboard here”
```

### Important distinction

Channel Sounding is a **ranging capability**, not a replacement high-bandwidth data protocol.

### Verdict

**Watch closely. Do not make it an MVP dependency.**

---

# Physical side channels

## 9. Screen-to-camera communication

This is one of the more unusual experiments.

A screen can encode data into:

* Animated QR frames
* Small brightness changes
* Colour modulation
* Visually imperceptible video patterns

Recent screen-camera research has demonstrated smartphone-to-smartphone visible-light links and visually imperceptible data embedding that standard cameras can decode. ([arXiv][12])

### Product experience

The laptop screen briefly displays a subtle animated pattern.

The phone camera receives:

```text
Peer identity
Ephemeral public key
Room key
Local IP candidate
WebRTC offer
```

This could establish a secure session without:

* Bluetooth permission
* Internet
* Same user account
* Typing a code

### Better variation

Do not transmit the whole note through the camera.

Use the visual channel to bootstrap a faster connection:

```text
Screen → camera: identity + keys + connection metadata
Wi-Fi/WebRTC: actual notes and files
```

### Verdict

**Excellent hackathon/demo feature and genuinely unusual.**

Animated QR is easier; invisible screen modulation is more novel.

---

## 10. Acoustic or ultrasonic pairing

Speakers and microphones can transmit small data payloads. Recent research continues to evaluate acoustic transmission as an alternative when Bluetooth and NFC are unavailable, including near-ultrasonic and nominally inaudible channels. ([ACM Digital Library][13])

### Possible use

The laptop emits a short chirp containing:

```text
room identifier
public-key fingerprint
short authentication code
```

The phone hears it and joins.

### Advantages

* Almost every phone and laptop has the hardware
* No network required
* Can support one-to-many broadcasting
* Useful for pairing

### Problems

* Background noise
* Microphone permissions
* Audio processing differences
* Potentially annoying sounds
* Privacy and covert-channel concerns
* Poor payload size

### Verdict

**Use for discovery or key exchange, not full synchronization.**

---

## 11. NFC tap-to-pair

NFC supports very short-range data exchange and is particularly useful for transferring small bootstrapping payloads. Android documents both tag interaction and device-to-device small-payload use cases. ([Android Developers][14])

### Experience

Tap phone against an NFC sticker attached to a monitor:

```text
Monitor identity
Workspace ID
Public key
Local endpoint
```

Then the phone connects using WebRTC, LAN, or internet.

The monitor itself does not necessarily need NFC hardware. A cheap passive tag can identify it.

### Strong niche

* Labs
* Universities
* Shared workstations
* Meeting rooms
* Factories
* Public displays

### Verdict

**Boring but highly practical.**

---

# Interesting innovations by ecosystem

## China: NearLink and distributed device fabrics

### NearLink

Huawei’s NearLink Kit exposes broadcasting, discovery, connection, and fast-transfer capabilities. Huawei is using NearLink in devices such as styluses and other local peripherals. ([Huawei Developer][15])

NearLink is strategically interesting because it is attempting to combine characteristics normally divided among Bluetooth, Wi-Fi, and precise local-device systems.

However, it is currently strongly tied to the Huawei/HarmonyOS ecosystem.

### OpenHarmony DSoftBus

OpenHarmony’s Distributed SoftBus provides a unified layer for discovery, connection, networking, and data transfer while hiding the underlying link technology. ([GitHub][16])

This is the architectural pattern you should copy:

```text
Application
    ↓
Unified device bus
    ↓
Wi-Fi / BLE / LAN / NearLink / other transport
```

Your product can be a smaller, cross-platform version of this idea.

### OPPO BeaconLink and Xiaomi Offline Communication

OPPO documents Bluetooth-based calling at approximately 200 metres in open conditions, while Xiaomi advertises proprietary offline phone communication reaching beyond one kilometre on supported devices under open, unobstructed conditions. ([OPPO][17])

These systems prove that OEM-controlled antennas, firmware, protocols, and device integration can push “Bluetooth communication” much further than ordinary application APIs.

However, I found consumer product documentation rather than a general, cross-vendor developer API. That makes them useful inspiration but poor foundations for an independent app.

---

## Europe and Finland: non-cellular 5G mesh

Wirepas’ NR+ implementation is based on the DECT-2020 NR standard and provides decentralized, non-cellular 5G mesh communication for large IoT deployments. ([Wirepas Developer Portal][18])

This is intended more for:

* Smart meters
* Industrial monitoring
* Infrastructure
* Massive IoT networks

It is not appropriate for a consumer notes MVP.

The useful lesson is the architecture:

> Every node can route, rather than requiring a permanent central access point.

---

## Global open-source: LoRa and resilient messaging

Meshtastic uses inexpensive LoRa radios to create long-range, off-grid mesh networks. Phones or computers connect to a radio through Bluetooth, Wi-Fi, or USB. ([meshtastic.org][19])

This opens a niche version of your product:

> Shared field notes for treks, disaster teams, events, farms, construction sites, or remote operations.

But it requires external hardware and has limited bandwidth.

---

# What I would actually build

## Product: **ScreenMesh**

Not a shared notes app.

> **A local-first device handoff fabric that moves objects between screens through any available connection.**

Objects:

```ts
type SharedObject =
  | Text
  | ClipboardItem
  | Link
  | Image
  | File
  | VoiceNote
  | CodeSnippet
  | Command
  | Task;
```

## Connection stack

```text
┌─────────────────────────────────────┐
│ Application: notes, clipboard, files│
├─────────────────────────────────────┤
│ CRDT / operation log / encryption   │
├─────────────────────────────────────┤
│ Delivery and routing                │
│ direct / relay / store-carry-forward│
├─────────────────────────────────────┤
│ Transport adapters                  │
│                                     │
│ WebRTC       WebSocket              │
│ LAN/UDP      Nearby Connections     │
│ Wi-Fi Aware  Apple peer-to-peer     │
│ QR/NFC       Optical/acoustic       │
│ LoRa         future Local P2P API   │
└─────────────────────────────────────┘
```

## Three operating modes

### Mode 1: Instant

Both devices have internet or a common network.

```text
WebRTC → direct transfer
WebSocket → fallback
```

### Mode 2: Nearby

No internet, but devices are physically close.

```text
QR/NFC → pairing
Nearby/Wi-Fi → transfer
```

### Mode 3: Eventual

No usable route currently exists.

```text
Encrypted bundle → local outbox
Later encounter → exchange
Trusted relay → optional delivery
```

---

# Best experiments to build

| Experiment                      |   Novelty |         Practicality | Recommendation              |
| ------------------------------- | --------: | -------------------: | --------------------------- |
| QR-bootstrapped direct sync     |    Medium |                 High | Build first                 |
| Store–carry–forward delivery    |      High |                 High | Core differentiator         |
| Android Nearby adapter          |    Medium |                 High | Build after PWA             |
| UWB point-to-send               | Very high |               Medium | Flagship demo               |
| Invisible screen-camera pairing | Very high |               Medium | Strong hackathon experiment |
| Ultrasonic pairing              |      High |           Low–medium | Research prototype          |
| LoRa field notes                |      High |                Niche | Separate vertical           |
| NearLink integration            |      High |   Low outside Huawei | Monitor                     |
| Browser Local P2P API           | Very high |   Not deployable yet | Track/contribute            |
| IWA Direct Sockets              |      High | Restricted currently | Desktop research            |

## My ranking

1. **Store–carry–forward encrypted sync**
2. **QR-bootstrapped WebRTC/LAN transfer**
3. **Transport negotiation and automatic fallback**
4. **Android Nearby Connections adapter**
5. **UWB or Channel Sounding target selection**
6. **Screen-camera optical pairing**

The unique idea is not:

> “Notes connected through Bluetooth.”

It is:

> **Your devices form an intermittent personal network. Content finds its way to the intended screen, even when no continuous connection exists.**

A recurring watch on Local Peer-to-Peer API, Direct Sockets, NearLink, Android UWB, and Bluetooth Channel Sounding would be useful; say **“set it up weekly”** to create it.

[1]: https://wicg.github.io/local-peer-to-peer/ "Local Peer-to-Peer API"
[2]: https://developer.chrome.com/docs/iwa/direct-sockets "Direct Sockets  |  Isolated Web Apps (IWA)  |  Chrome for Developers"
[3]: https://developer.chrome.com/docs/iwa/introduction "Isolated Web Apps (IWA)  |  Chrome for Developers"
[4]: https://www.nasa.gov/communicating-with-missions/delay-disruption-tolerant-networking/?utm_source=chatgpt.com "Delay/Disruption Tolerant Networking"
[5]: https://play.google.com/store/apps/details?hl=en_IN&id=org.briarproject.briar.android&utm_source=chatgpt.com "Briar – Apps on Google Play"
[6]: https://developers.google.com/nearby/connections/overview "Overview  |  Nearby Connections  |  Google for Developers"
[7]: https://developers.google.com/nearby/connections/swift/get-started "Get started  |  Nearby Connections  |  Google for Developers"
[8]: https://developer.android.com/develop/connectivity/wifi/wifi-aware "Wi-Fi Aware overview  |  Connectivity  |  Android Developers"
[9]: https://developer.apple.com/documentation/multipeerconnectivity?utm_source=chatgpt.com "Multipeer Connectivity | Apple Developer Documentation"
[10]: https://developer.apple.com/documentation/nearbyinteraction?utm_source=chatgpt.com "Nearby Interaction | Apple Developer Documentation"
[11]: https://www.bluetooth.com/learn-about-bluetooth/feature-enhancements/channel-sounding/?utm_source=chatgpt.com "Bluetooth® Channel Sounding"
[12]: https://arxiv.org/abs/2506.23005?utm_source=chatgpt.com "Channel characterization in screen-to-camera based optical camera communication"
[13]: https://dl.acm.org/doi/10.1145/3779439?utm_source=chatgpt.com "Evaluating Acoustic Data Transmission Schemes for Ad- ..."
[14]: https://developer.android.com/develop/connectivity/nfc?utm_source=chatgpt.com "Near field communication (NFC) overview | Connectivity"
[15]: https://developer.huawei.com/consumer/cn/sdk/nearlink-kit/?utm_source=chatgpt.com "NearLink Kit（星闪服务）| 华为开发者联盟"
[16]: https://github.com/openharmony/communication_dsoftbus?utm_source=chatgpt.com "openharmony/communication_dsoftbus: 暂无描述"
[17]: https://www.oppo.com/in/smartphones/series-reno/reno12/ "OPPO Reno12 | Powerful AI Features and Rapid Charging | OPPO India"
[18]: https://developer.wirepas.com/support/solutions/articles/77000560718-wirepas-5g-mesh-overview?utm_source=chatgpt.com "Wirepas 5G Mesh overview"
[19]: https://meshtastic.org/docs/introduction/?utm_source=chatgpt.com "Introduction"
