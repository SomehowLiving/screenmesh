# ScreenMesh FAQ

## What is ScreenMesh?

ScreenMesh is a private workspace for your own devices.

It lets you move useful things—notes, links, code, images, files, checklists, commands, and more—between a phone, laptop, desktop, tablet, or display without treating every transfer as a trip through a different consumer app.

The simple idea is:

> Capture something once, send it privately, and continue it on the device that makes the most sense.

It is not trying to be another social drive, team chat, or public cloud. It is a local-first device mesh.

## Why does this product exist?

Moving work between devices is still strangely fragmented. A person might send themselves a message for a short note, email a file, save a link in a browser, use a cloud drive for an image, copy a command into a terminal, and keep a separate checklist on their phone.

Those tools work, but they make one person’s devices feel disconnected.

ScreenMesh treats paired devices as one private workspace. The transfer mechanism is important, but the real goal is continuity: open a link on a phone, continue code on a laptop, put a checklist on a tablet, or queue a file for a desktop that is currently asleep.

## What can I send?

ScreenMesh currently supports:

- Short text and long-form documents
- Links
- Code snippets
- Images and files
- Checklists
- Temporary clipboard content
- Commands, which require explicit approval on a trusted desktop agent
- Structured agent tasks for supported desktop agents

Long text can be sent as a document with an optional title. Documents use the same encrypted mesh delivery as other objects, but open in a larger editing surface instead of being treated as a disposable message.

## Is this like AirDrop?

In spirit, yes: ScreenMesh is often easiest to understand as an encrypted, multi-device version of AirDrop.

It goes further in a few ways:

- It can queue an encrypted object if the destination is offline.
- It can use more than one route, including direct peer connections and an encrypted relay fallback.
- It supports objects that can remain useful after arrival, such as editable text, documents, and checklists.
- It can route to a capability, such as a paired device that has a terminal or browser.

## Do I need an account?

No. Devices create their own local cryptographic identity. Pairing is done with a QR code or pairing link, not a username and password.

## Does ScreenMesh store my data in the cloud?

Your local device storage is the primary place ScreenMesh keeps your objects.

When an encrypted relay is needed for delivery, it only handles encrypted envelopes. It is not intended to hold a readable cloud database of your notes, files, or documents. Offline delivery may temporarily require encrypted relay storage or an encrypted local queue until the target device reconnects.

## Can the relay read my content?

No. Object content is encrypted before it leaves the sending device. A relay routes encrypted bytes; it should not have the keys needed to read the object contents.

Likewise, a device carrying an encrypted bundle for another device cannot read a bundle that is sealed for the real destination.

## What security does ScreenMesh use?

At a high level:

- Each device has its own Ed25519 identity.
- Paired devices use X25519 key agreement and forward-secret Double Ratchet sessions.
- Object envelopes are encrypted and signed before transport.
- Devices reject replayed messages and verify sender identity.
- The workspace owner can revoke a paired device.

This is designed so that transport infrastructure can help deliver data without becoming trusted with the plaintext.

## Is ScreenMesh anonymous or invisible on the network?

No. Encryption protects content, not every possible piece of metadata. A relay necessarily knows enough to route encrypted traffic, such as that a paired device is connected and where an encrypted message should go. Network operators may also observe ordinary connection metadata.

ScreenMesh is for protecting private content across trusted paired devices. It is not a replacement for an anonymity network, a VPN, or an enterprise data-loss-prevention system.

## What happens if a target device is offline?

The send is queued safely on the sending device and retried automatically when a trusted route becomes available. Depending on the available transport, ScreenMesh can try direct peer delivery, WebRTC, an encrypted relay, nearby transport, or store-carry-forward through a trusted paired device.

The UI should simply say that the object is queued safely or waiting for a device. Transfers, Mesh, and Activity provide the deeper explanation when you need it.

## Can I choose where something goes?

Yes. You can send to one device, several devices, or everyone in the workspace.

You can also choose capability routing: for example, send a command to whichever paired device advertises a terminal, or a link to a device with a browser. ScreenMesh may suggest a suitable device, but it does not silently change your chosen recipient.

## Can I edit something after I send it?

Text, documents, code snippets, and links are collaboratively editable. Their text changes use Yjs-based synchronization, so concurrent edits are designed to merge rather than overwrite each other.

Checklists can also be updated from paired devices. Files and images are viewable, copyable, and downloadable, but are not edited in place by ScreenMesh.

## Who can copy, edit, or delete an object?

Any paired recipient who can view an object can copy its text or download its file contents. Shared text, documents, code, links, and checklists are collaborative by default, so trusted recipients can edit them.

The current **Delete** action removes the object only from the device where it is pressed. It does not remotely delete another device’s copy or revoke previously downloaded data.

Per-object view-only permissions, sender-controlled deletion everywhere, and controlled re-sharing are future features. They need protocol-level enforcement, not just UI controls, before they should be relied upon.

## Can I make something temporary?

Yes. A send can be configured to never expire or expire after 10 minutes, 1 hour, or 24 hours. You can also choose to delete a recipient’s local copy after it is opened, or require explicit acceptance before delivery counts as accepted.

Expiration is useful for transient handoffs, not as a guarantee that a recipient never copied the information elsewhere before it expired.

## What is the difference between Workspace and Library?

**Workspace** is for active work: compose a send, handle incoming objects, see what needs attention, and continue something on another device.

**Library** is the private archive on this device: search objects, browse by type, pin important items, add local tags, and mark something to continue later.

Pins, tags, recents, and “continue later” are local organization choices. They do not reorganize another person’s device.

## What are Transfers, Activity, Mesh, and Security for?

They are inspection views, not the main working surface.

- **Transfers** shows delivery state: delivered, queued, pending approval, and so on.
- **Activity** explains meaningful events in the mesh, such as a device joining, a payload being delivered, or a route changing.
- **Mesh** shows route and eventual-delivery state.
- **Security** explains the current workspace trust and encryption posture.

Most of the time you should not need to open them. They exist for confidence and diagnosis when you do.

## Can I use ScreenMesh as permanent cloud storage?

Not yet, and that is not its primary purpose. ScreenMesh is best for private working objects and handoffs between devices. Keep important long-term originals in an appropriate backup system as well.

## What happens when I revoke a device?

The workspace owner can revoke a paired device, cutting its access to the workspace and removing its local trust/session state from other devices.

Revocation prevents future workspace access. It cannot erase information that a device already copied, downloaded, or recorded outside ScreenMesh before revocation.

## Is it safe to send commands to another device?

Treat commands with care. ScreenMesh routes command objects to a trusted desktop agent, but that agent requires an explicit human approval prompt before executing anything. Commands are never meant to run automatically.

Only pair devices you trust, and review command text before approving it.

## What should I use ScreenMesh for?

Good examples include:

- Sending a useful link from phone to laptop without messaging yourself
- Moving a screenshot or small file to a work device
- Writing a draft on one device and continuing it on another
- Keeping a shared personal checklist in sync across devices
- Sending a terminal command to a desktop for review and approval
- Queuing work for a device that is temporarily offline
- Giving a display or tablet the media or notes it should show

## What should I not use it for?

Do not treat ScreenMesh as a replacement for backups, enterprise access controls, legal retention systems, public sharing, or an anonymity service.

Also remember the human boundary: encryption can protect data in transit and at the relay, but it cannot prevent a trusted recipient from taking a screenshot, copying text, or downloading a file they are allowed to view.

## How can I report a problem or suggest an improvement?

Start with the relevant view:

- A delivery issue: inspect **Transfers** and **Mesh**.
- A surprising state change: inspect **Activity**.
- A pairing or trust concern: inspect **Devices** and **Security**.

Include what you sent, which device was involved, what status you saw, and roughly when it happened. Avoid posting sensitive object contents or pairing secrets in public issue reports.
