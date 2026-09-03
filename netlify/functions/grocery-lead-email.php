<?php
/* =============================================================
 * GROCERY LIST — LEAD SUBMISSION EMAIL HANDLER
 * Paste into WPCode as a snippet: type "PHP Snippet",
 * location "Run Everywhere". Do NOT wrap in <?php ?> tags again
 * (WPCode adds those) — just paste everything from "add_action"
 * onward if the snippet editor already opens with <?php present.
 *
 * This listens for the "llg_submit_list" admin-ajax action fired
 * by the widget's "Submit My List" button, and sends two emails
 * via wp_mail() — which routes through whatever SMTP provider is
 * configured in WP Mail SMTP Pro, so delivery is reliable instead
 * of depending on the visitor's own email client (mailto:).
 * ============================================================= */

// IMPORTANT: set this to where you want order/lead notifications sent.
if (!defined('LLG_ADMIN_NOTIFY_EMAIL')) {
    define('LLG_ADMIN_NOTIFY_EMAIL', 'mamonarehmanm@gmail.com');
}

add_action('wp_ajax_llg_submit_list', 'llg_handle_submit_list');
add_action('wp_ajax_nopriv_llg_submit_list', 'llg_handle_submit_list'); // allow logged-out visitors

function llg_handle_submit_list() {
    $name      = isset($_POST['name']) ? sanitize_text_field(wp_unslash($_POST['name'])) : '';
    $email     = isset($_POST['email']) ? sanitize_email(wp_unslash($_POST['email'])) : '';
    $list_text = isset($_POST['list_text']) ? sanitize_textarea_field(wp_unslash($_POST['list_text'])) : '';

    if (empty($name) || empty($email) || !is_email($email) || empty($list_text)) {
        wp_send_json(array(
            'success' => false,
            'data'    => array('message' => 'Please provide a valid name, email, and a non-empty list.'),
        ));
    }

    // ---- Build a clean, ink-friendly, high-density plain-text checklist ----
    // No images, no HTML, no heavy styling — just a readable list, since
    // this may be printed or read on a low-end device.
    $checklist  = "NEW GROCERY LIST SUBMISSION\n";
    $checklist .= str_repeat('-', 32) . "\n";
    $checklist .= "Name:  {$name}\n";
    $checklist .= "Email: {$email}\n";
    $checklist .= "Submitted: " . current_time('F j, Y g:i A') . "\n";
    $checklist .= str_repeat('-', 32) . "\n\n";
    $checklist .= $list_text . "\n";

    $headers = array('Content-Type: text/plain; charset=UTF-8');

    // ---- 1) Notify the admin/team ----
    $admin_sent = wp_mail(
        LLG_ADMIN_NOTIFY_EMAIL,
        'New Grocery List Submission — ' . $name,
        $checklist,
        $headers
    );

    // ---- 2) Confirmation copy to the customer ----
    $customer_message  = "Hi {$name},\n\n";
    $customer_message .= "Thanks for submitting your grocery list! Here's a copy for your records:\n\n";
    $customer_message .= str_repeat('-', 32) . "\n\n";
    $customer_message .= $list_text . "\n\n";
    $customer_message .= str_repeat('-', 32) . "\n";
    $customer_message .= "We'll be in touch shortly.\n";

    $customer_sent = wp_mail(
        $email,
        'Your Grocery List — Confirmation',
        $customer_message,
        $headers
    );

    if ($admin_sent) {
        wp_send_json(array('success' => true));
    } else {
        // Admin email failed — still let the customer know something's off,
        // even if their own confirmation copy went out fine.
        wp_send_json(array(
            'success' => false,
            'data'    => array('message' => 'Your list was received but we hit an issue notifying our team — please also send it directly if you can.'),
        ));
    }
}