/* TouchpadIndicator - Touchpad management GNOME Shell Extension.
 * Orignal work Copyright (C) 2011-2013 Armin Köhler <orangeshirt at web.de>
 * Modifcations Copyright (C) 2019 Ashesh Singh <user501254 at gmail.com>
 *
 * This file is part of TouchpadIndicator, a fork of Armin Köhler's
 * 'gnome-shell-extension-touchpad-indicator' project which is licensed GPLv2.
 * Orignal source code is available at https://git.io/fjVec.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program; if not, write to:
 * The Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor
 * Boston, MA 02110-1301, USA.
 */

const { Gio, Gtk } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;
const XInput = Me.imports.xinput;
const Synclient = Me.imports.synclient;

// Settings
const SCHEMA_EXTENSION = 'org.gnome.shell.extensions.touchpad-indicator';
const SCHEMA_TOUCHPAD = 'org.gnome.desktop.peripherals.touchpad';

var Settings = class TouchpadIndicatorSettings {
    constructor() {

        let settings = new Gio.Settings({ schema_id: SCHEMA_TOUCHPAD });
        let synclient = new Synclient.Synclient();
        let xinput = new XInput.XInput();

        this._settings = ExtensionUtils.getSettings(SCHEMA_EXTENSION);

        this._rtl = (Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL);

        this._builder = new Gtk.Builder();
        this._builder.set_translation_domain(Me.metadata['gettext-domain']);
        this._builder.add_from_file(`${Me.path}/Settings.ui`);

        this.widget = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this._notebook = this._builder.get_object('ti_notebook');
        this.widget.add(this._notebook);

        this._populateGeneralTab(synclient, xinput);
        this._populateDebugTab(settings, synclient, xinput);
        this._populateAboutTab();

        this._bindSettings(settings, synclient, xinput);

        // Set a reasonable initial window height
        this.widget.connect('realize', () => {
            let window = this.widget.get_toplevel();
            window.resize(640, 550);
        });
    }

    _bindSettings(settings, synclient, xinput) {
        // repopulate debug tab on notebook page switch
        this._builder.get_object('ti_notebook').connect('switch-page',
            () => {
                this._populateDebugTab(settings, synclient, xinput);
            });

        // on General tab
        this._settings.bind('switchmethod',
            this._builder.get_object('switchmethod_combo'),
            'active-id',
            Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('show-panelicon',
            this._builder.get_object('show_panelicon_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('autoswitch-touchpad',
            this._builder.get_object('autoswitch_touchpad_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('show-notifications',
            this._builder.get_object('show_notifications_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        this._builder.get_object('calibrate_button').connect('clicked',
            () => {

                // Grab number of mouse devices and set it as the new extension value
                let pointingDevices = Lib.listPointingDevices()[1];
                let mouseDevices = pointingDevices.filter(p => p.type === 'mouse');
                let mouseCount = mouseDevices.length;

                this._settings.set_int('mouse-count', mouseCount);
            });
        
        this._builder.get_object('reset_button').connect('clicked',
            () => {
                let keys = this._settings.list_keys();
                for (let i = 0; i < keys.length; i++) {
                    this._settings.reset(keys[i]);
                }

                synclient._enable();
                xinput._enableAll();

                this._builder.get_object('reset_button').set_sensitive(false);
            });

        // on Debug tab
        this._settings.bind('debug',
            this._builder.get_object('debug_switch'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        this._settings.bind('debug-to-file',
            this._builder.get_object('debug_to_file_checkbox'),
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        this._builder.get_object('debug_switch').connect('state-set',
            () => {
                let state = !this._builder.get_object('debug_switch').get_state();
                this._builder.get_object('debug_to_file_checkbox').set_visible(state);
                this._builder.get_object('debug_to_file_checkbox').set_active(state);
            });

        this._builder.get_object('debug_to_file_checkbox').connect('toggled',
            () => {
                let state = this._builder.get_object('debug_to_file_checkbox').get_active();
                this._builder.get_object('log_scrolled_window').set_visible(state);
                this._builder.get_object('log_text_view').set_visible(state);
            });

        this._watchLogFile = Lib.watchLogFile();
        this._watchLogFileSignal = this._watchLogFile.connect('changed',
            this._updateLogView.bind(this));

        // on About tab
        this._builder.get_object('issue_button').connect('clicked',
            () => {
                Lib.executeCmdAsync(`xdg-open ${Me.metadata.repository}/issues/new`);
            });
    }

    _populateGeneralTab(synclient, xinput) {
        if (synclient.isUsable !== true) {
            this._builder.get_object('switchmethod_combo').remove(
                Lib.METHOD.SYNCLIENT
            );
        }

        if (xinput.isUsable !== true) {
            this._builder.get_object('switchmethod_combo').remove(
                Lib.METHOD.XINPUT
            );
        }

        // Format the toggle Touchpad shortcut string.
        // Setting incorrect custom keybinding is user's fault.
        let toggleTouchpad = this._settings.get_strv('toggle-touchpad').toString();
        toggleTouchpad = toggleTouchpad.split(/<(.*?)>/g).filter(Boolean).join(' + ');
        toggleTouchpad = `<tt>${toggleTouchpad}</tt>`;
        this._builder.get_object('toggle_touchpad_label').set_label(toggleTouchpad);
    }

    _populateDebugTab(settings, synclient, xinput) {
        let gsVersion = Lib.executeCmdSync('gnome-shell --version')[1];
        this._builder.get_object('gnome-shell-version').set_label(gsVersion);

        let touchpadEnabled = this._settings.get_boolean('touchpad-enabled').toString();
        this._builder.get_object('touchpadenabled').set_label(touchpadEnabled);

        let sendEvents = settings.get_string('send-events');
        this._builder.get_object('sendevents').set_label(sendEvents);

        let touchpads = xinput._filterByType('touchpad').names.toString();
        this._builder.get_object('touchpads').set_label(touchpads);

        let switchmethod = this._settings.get_string('switchmethod');
        this._builder.get_object('switchmethod').set_label(switchmethod);

        if (synclient.isUsable) {
            let synclientVersion = Lib.executeCmdSync('synclient -V')[1];
            this._builder.get_object('synclient').set_label(synclientVersion);
        }

        if (xinput.isUsable) {
            let xinputVersion = Lib.executeCmdSync('xinput --version')[1];
            this._builder.get_object('xinput').set_label(xinputVersion);
        }

        let debug = this._settings.get_boolean('debug');
        let debugToFile = this._settings.get_boolean('debug-to-file');

        if (debug) {
            this._builder.get_object('debug_to_file_checkbox').set_visible(true);
            this._builder.get_object('debug_to_file_checkbox').set_active(
                debugToFile);
            this._builder.get_object('log_scrolled_window').set_visible(
                debugToFile);
            this._builder.get_object('log_text_view').set_visible(
                debugToFile);

            if (debugToFile) {
                this._updateLogView();
            }
        }
    }

    _updateLogView() {
        this._builder.get_object('log_text_buffer').set_text(Lib.readLog()[1], -1);
        this._builder.get_object('log_text_view').scroll_to_iter(
            this._builder.get_object('log_text_buffer').get_end_iter(),
            0.0, true, 0.5, 1
        );
    }

    _populateAboutTab() {
        let version = Me.metadata.version;
        let releaseTag = `TouchpadIndicator-extensions.gnome.org-v${version}`;
        this._builder.get_object('release_linkbutton').set_label(releaseTag);

        let repository = Me.metadata.repository;
        let releaseUrl = `${repository}/releases/${releaseTag}`;
        this._builder.get_object('release_linkbutton').set_uri(releaseUrl);
    }
};

function init() {
    ExtensionUtils.initTranslations();
}

function buildPrefsWidget() {
    let settings = new Settings();
    let widget = settings.widget;
    widget.show();
    return widget;
}


/* exported init buildPrefsWidget*/