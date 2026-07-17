package com.screenmesh.transport.nearby

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.IntentFilter
import android.nfc.FormatException
import android.os.Build
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * Real (not stubbed) NFC pairing helper. NFC here is pairing-only, not a
 * data transport — bandwidth and range are far too limited for envelope
 * traffic — matching docs/Roadmap.md Phase 3's "NFC tap-to-pair via
 * passive tags on shared displays" design. This is deliberately NOT a
 * phone-to-phone Android Beam flow: `setNdefPushMessage`/Beam is
 * deprecated (and removed from the launcher UI) on modern Android. The
 * intended flow instead: a shared display (or either phone, put into
 * "write" mode) writes its pairing code onto a blank/rewritable NFC tag;
 * any other phone taps the tag and reads back the same pairing code that
 * would otherwise come from scanning the QR.
 *
 * This is a set of pure helper functions, not a MeshTransport — NFC
 * foreground-dispatch registration is inherently Activity-lifecycle-bound
 * (`enableForegroundDispatch`/`disableForegroundDispatch` must be called
 * from `onResume`/`onPause` of a live Activity), so that wiring belongs in
 * the hosting Activity, not hidden inside a plain class.
 *
 * UNTESTED: written against the documented android.nfc APIs with no NFC
 * hardware available in this environment to run it on. See docs/Android.md.
 */
object NfcPairing {
    private const val MIME_TYPE = "application/vnd.screenmesh.pairing"

    /** Builds the NDEF message to write onto a tag for a given pairing code. */
    fun buildPairingNdefMessage(pairingCode: String): NdefMessage {
        val record = NdefRecord.createMime(MIME_TYPE, pairingCode.toByteArray(StandardCharsets.UTF_8))
        return NdefMessage(arrayOf(record))
    }

    /**
     * Writes the pairing code onto a tag just scanned while the Activity is
     * in "write mode" (i.e. its own foreground dispatch is active and this
     * is called from its NDEF_DISCOVERED handler with the Tag extra).
     * Formats the tag first if it's blank and formattable.
     */
    @Throws(IOException::class, FormatException::class)
    fun writePairingCodeToTag(tag: Tag, pairingCode: String) {
        val message = buildPairingNdefMessage(pairingCode)
        val ndef = Ndef.get(tag)
        if (ndef != null) {
            ndef.connect()
            try {
                ndef.writeNdefMessage(message)
            } finally {
                ndef.close()
            }
            return
        }
        val formatable = NdefFormatable.get(tag) ?: throw IOException("tag is not NDEF-writable")
        formatable.connect()
        try {
            formatable.format(message)
        } finally {
            formatable.close()
        }
    }

    /**
     * Extracts a pairing code from an NDEF_DISCOVERED intent (delivered via
     * foreground dispatch or a manifest intent-filter). Returns null if the
     * intent carries no ScreenMesh pairing record.
     */
    @Suppress("DEPRECATION") // the typed overload is API 33+; minSdk here is 26
    fun readPairingCodeFromIntent(intent: Intent): String? {
        val rawMessages = intent.getParcelableArrayExtra(NfcAdapter.EXTRA_NDEF_MESSAGES) ?: return null
        for (raw in rawMessages) {
            val message = raw as? NdefMessage ?: continue
            for (record in message.records) {
                if (record.tnf == NdefRecord.TNF_MIME_MEDIA && String(record.type, StandardCharsets.US_ASCII) == MIME_TYPE) {
                    return String(record.payload, StandardCharsets.UTF_8)
                }
            }
        }
        return null
    }

    /**
     * Call from the hosting Activity's onResume to start intercepting NFC
     * tag taps while the Activity is in the foreground (required — NFC
     * foreground dispatch is per-Activity, not global). Must be paired
     * with disableForegroundDispatch in onPause.
     */
    fun enableForegroundDispatch(activity: Activity) {
        val adapter = NfcAdapter.getDefaultAdapter(activity) ?: return
        // FLAG_MUTABLE only exists from API 31 (minSdk here is 26) — NFC
        // foreground dispatch needs a mutable PendingIntent on 31+ to
        // receive the tag intent's extras, but below that there's no such
        // flag (and none is needed).
        val mutabilityFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pendingIntent = PendingIntent.getActivity(
            activity,
            0,
            Intent(activity, activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            mutabilityFlag,
        )
        val ndefFilter = IntentFilter(NfcAdapter.ACTION_NDEF_DISCOVERED)
        adapter.enableForegroundDispatch(activity, pendingIntent, arrayOf(ndefFilter), null)
    }

    /** Call from the hosting Activity's onPause — must pair with enableForegroundDispatch. */
    fun disableForegroundDispatch(activity: Activity) {
        NfcAdapter.getDefaultAdapter(activity)?.disableForegroundDispatch(activity)
    }
}
