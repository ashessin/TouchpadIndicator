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

const { Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const Mainloop = imports.mainloop;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;
const XInput = Me.imports.xinput;
const Synclient = Me.imports.synclient;

//schema
const SCHEMA_EXTENSION = 'org.gnome.shell.extensions.touchpad-indicator';
const SCHEMA_TOUCHPAD = 'org.gnome.desktop.peripherals.touchpad';

//keys
const KEY_SEND_EVENTS = 'send-events';
const KEY_SWCH_METHOD = 'switchmethod';
const KEY_ALWAYS_SHOW = 'show-panelicon';
const KEY_NOTIFS_SHOW = 'show-notifications';
const KEY_TPD_ENABLED = 'touchpad-enabled';
const KEY_TPT_ENABLED = 'trackpoint-enabled';
const KEY_TSN_ENABLED = 'touchscreen-enabled';
const KEY_FTH_ENABLED = 'fingertouch-enabled';
const KEY_PEN_ENABLED = 'pen-enabled';
const KEY_MOUSECOUNT  = 'mouse-count';

//icons
const ICON_ENABLED = 'input-touchpad-symbolic';

//sets
const NON_TPD_SET = [KEY_PEN_ENABLED, KEY_FTH_ENABLED, KEY_TSN_ENABLED, KEY_TPT_ENABLED];

//localization
const Gettext = imports.gettext.domain(Me.metadata['gettext-domain']);
// eslint-disable-next-line no-redeclare
const _ = Gettext.gettext;

function logging(event) {
    if (Lib.DEBUG) {
        Lib.logger(`TouchpadIndicator.${event}`);
    }
}

var TouchpadIndicator = GObject.registerClass(
class TouchpadIndicatorButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Touchpad Indicator');
        this.hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box'
        });
        this.icon = new St.Icon({
            icon_name: ICON_ENABLED,
            style_class: 'system-status-icon'
        });
        this.hbox.add_child(this.icon);
        this.hbox.add_child(PopupMenu.arrowIcon(St.Side.BOTTOM));
        this.add_child(this.hbox);

        this._extSettings = ExtensionUtils.getSettings(SCHEMA_EXTENSION);
        this._tpdSettings = new Gio.Settings({ schema_id: SCHEMA_TOUCHPAD });

        // Purely for logging and debugging
        this._debug = this._extSettings.get_boolean('debug');
        Lib.DEBUG = this._debug;
        this._keyDebugSignal = this._extSettings.connect(
            'changed::debug',
            this._onDebugSignal.bind(this));

        this._debugToFile = this._extSettings.get_boolean('debug-to-file');
        Lib.DEBUG_TO_FILE = this._debugToFile;
        this._keyDebugToFileSignal = this._extSettings.connect(
            'changed::debug-to-file',
            this._onDebugSignal.bind(this));

        this._logEKeyChangeSignal = this._extSettings.connect(
            `changed::${KEY_TPD_ENABLED}`,
            this._logEKeyChange.bind(this));
        this._logSKeyChangeSignal = this._tpdSettings.connect(
            `changed::${KEY_SEND_EVENTS}`,
            this._logSKeyChange.bind(this));

        logging('_init()');
        // TODO: Let user set program start touchpad state
        //       None, Enabled, Disabled

        // Switch method to start with
        this._switchMethod = this._extSettings.get_enum(KEY_SWCH_METHOD);
        this._switchMethodChanged = false;

        logging(`_init(): Switch method is ${this._switchMethod}`);

        // SYNCLIENT related
        this.synclient = new Synclient.Synclient();
        if (this.synclient.isUsable !== true &&
            this._switchMethod === Lib.METHOD.SYNCLIENT) {
            logging('_init(): Can\'t use Synclient, defaulting to GSettings');
            this._extSettings.set_enum(KEY_SWCH_METHOD, Lib.METHOD.GSETTINGS);
            this._switchMethodChanged = true;
        }

        // XINPUT related
        this.xinput = new XInput.XInput();
        if (this.xinput.isUsable !== true &&
            this._switchMethod === Lib.METHOD.XINPUT) {
            logging('_init(): Can\'t use Xinput, defaulting to GSettings');
            this._extSettings.set_enum(KEY_SWCH_METHOD, Lib.METHOD.GSETTINGS);
            this._extSettings.set_boolean('autoswitch-trackpoint', false);
            this._switchMethodChanged = true;
        }

        // Resets
        if (this._switchMethod !== Lib.METHOD.SYNCLIENT) {
            this.synclient._enable();
        }

        if (this._switchMethod !== Lib.METHOD.XINPUT) {
            this.xinput._enableAll();
        }

        if (this._switchMethod !== Lib.METHOD.GSETTINGS) {
            if (this._tpdSettings.get_string(KEY_SEND_EVENTS) !== 'enabled' &&
                this._extSettings.get_boolean(KEY_TPD_ENABLED) === true)
                this._tpdSettings.set_string(KEY_SEND_EVENTS, 'enabled');
        }

        // System `send-events` change signal
        this._tpdSendEventsSignal = this._tpdSettings.connect(
            `changed::${KEY_SEND_EVENTS}`,
            this._queueSyncPointingDevice.bind(this));

        // Extension `show-panelicon` change signal
        this._keyAlwaysShowSignal = this._extSettings.connect(
            `changed::${KEY_ALWAYS_SHOW}`,
            this._queueSyncMenuVisibility.bind(this));

        // Extension `switchmethod` change signal
        this._keySwitchMthdSignal = this._extSettings.connect(
            `changed::${KEY_SWCH_METHOD}`,
            this._syncSwitchMethod.bind(this));

        // Emulate that a mouse is currently plugged in
        this._onMouseDevicePlugged(2);

        this._queueSyncPointingDevice(KEY_TPD_ENABLED);
        this._updateIcon();

        // To store all change signals on `*-enabled` extension keys
        this._enabledSignals = [];

        let touchpad = this._buildItem(_('Touchpad'), KEY_TPD_ENABLED);
        this.menu.addMenuItem(touchpad);

        if (this.xinput._isPresent('trackpoint')) {
            let trackpoint = this._buildItem(_('Trackpoint'), KEY_TPT_ENABLED);
            this.menu.addMenuItem(trackpoint);
        }
        if (this.xinput._isPresent('touchscreen')) {
            let touchscreen = this._buildItem(_('Touchscreen'), KEY_TSN_ENABLED);
            this.menu.addMenuItem(touchscreen);
        }
        if (this.xinput._isPresent('fingertouch')) {
            let fingertouch = this._buildItem(_('Fingertouch'), KEY_FTH_ENABLED);
            this.menu.addMenuItem(fingertouch);
        }
        if (this.xinput._isPresent('pen')) {
            let pen = this._buildItem(_('Pen'), KEY_PEN_ENABLED);
            this.menu.addMenuItem(pen);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addSettingsAction(_('Mouse & Touchpad Preferences'),
            'gnome-mouse-panel.desktop');
        this.menu.addAction(_('Indicator Preferences'), () => {
            Lib.executeCmdAsync(`gnome-shell-extension-prefs ${Me.uuid}`);
        });

        this._syncMenuVisibility();

        this._watchDevInput = Lib.watchDevInput();
        this._watchDevInputSignal = this._watchDevInput.connect('changed',
            this._onDevicePlugged.bind(this));

        this._addKeybinding();
    }

    _logSKeyChange() {
        logging('_logSKeyChange(): System `send-events` Key Changed');
    }

    _logEKeyChange() {
        logging('_logEKeyChange(): Extension `touchpad-enabled` Key Changed');
    }

    _buildItemExtended(string, initialValue, writable, onSet) {
        let widget = new PopupMenu.PopupSwitchMenuItem(string,
            initialValue);
        if (!writable) {
            widget.actor.reactive = false;
        } else {
            widget.connect('toggled', item => {
                onSet(item.state);
            });
        }
        // TODO: Warn/Confirm if user is disabling the last pointing device.
        return widget;
    }

    _buildItem(string, key) {
        let signal = this._extSettings.connect(`changed::${key}`, () => {
            widget.setToggleState(this._extSettings.get_boolean(key));
            this._queueSyncPointingDevice(key);
            this._queueSyncMenuVisibility();
            this._updateIcon();
        });

        this._enabledSignals.push(signal);

        let widget = this._buildItemExtended(string,
            this._extSettings.get_boolean(key),
            this._extSettings.is_writable(key),
            (enabled) => {
                if (this._extSettings.get_boolean(key) !== enabled) {
                    logging(`_buildItem(...): ${string} switch set to ${enabled}.`);
                    this._extSettings.set_boolean(key, enabled);
                }
            });
        return widget;
    }

    _queueSyncMenuVisibility() {
        if (this._syncMenuVisibilityIdle) {
            return;
        }

        this._syncMenuVisibilityIdle = Mainloop.idle_add(
            this._syncMenuVisibility.bind(this));
        GLib.Source.set_name_by_id(this._syncMenuVisibilityIdle,
            '[gnome-shell] this._syncMenuVisibility');
    }

    _syncMenuVisibility() {
        this._syncMenuVisibilityIdle = 0;

        let alwaysShow = this._extSettings.get_boolean(KEY_ALWAYS_SHOW);
        let items = this.menu._getMenuItems();

        // Show panel icon if `show-panelicon` is true or at least one of the
        // device switches is in the off position.
        this.visible = alwaysShow || items.some(s => s.state === false);

        return GLib.SOURCE_REMOVE;
    }

    _notify(iconName, title, text) {
        if (this._notification) {
            this._notification.destroy();
        }

        this._ensureSource();

        let gicon = new Gio.ThemedIcon({ name: iconName });
        this._notification = new MessageTray.Notification(this._source, title,
            text, { gicon: gicon });
        this._notification.setUrgency(MessageTray.Urgency.LOW);
        this._notification.setTransient(true);
        this._notification.connect('destroy', () => {
            this._notification = null;
        });
        this._source.notify(this._notification);
    }

    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source('Touchpad Indicator',
                'touchpad-indicator');

            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
    }

    _syncSwitchMethod() {
        logging('_syncSwitchMethod()');

        let oldSwitchMethod = this._switchMethod;

        this._switchMethod = this._extSettings.get_enum(KEY_SWCH_METHOD);
        this._switchMethodChanged = true;
        logging(`_syncSwitchMethod(): old ${oldSwitchMethod}`);
        logging(`_syncSwitchMethod(): new ${this._switchMethod}`);

        if (this._switchMethod !== Lib.METHOD.XINPUT) {
            this.xinput._enableByType('touchpad');
        }
        if (this._switchMethod !== Lib.METHOD.SYNCLIENT) {
            this.synclient._enable();
        }

        this._queueSyncPointingDevice(KEY_TPD_ENABLED);
    }

    _checkGconfSync(valTpdEnabled, valSendEvents) {
        logging(`_checkGconfSync(${valTpdEnabled}, ${valSendEvents})`);

        let bothEnabled = ((valTpdEnabled === true) &&
            (valSendEvents === 'enabled'));
        let bothDisabled = ((valTpdEnabled === false) &&
            (valSendEvents === 'disabled'));

        return (bothEnabled || bothDisabled);
    }

    _queueSyncPointingDevice(key) {
        logging(`_queueSyncPointingDevice(${key})`);

        // TODO: Check further for recursion, reduce complexity
        let valSendEvents = this._tpdSettings.get_string(KEY_SEND_EVENTS);
        let valTpdEnabled = this._extSettings.get_boolean(KEY_TPD_ENABLED);

        let isGconfInSync = this._checkGconfSync(valTpdEnabled, valSendEvents);

        // NOTE: When switch method is other than gconf (ie. xinput, synclient)
        //       let system's touchpad settings (`send-events` key) work on top
        //       of the switch method's touchpad enabling/disabling mechanism.
        if (isGconfInSync && (this._switchMethodChanged === false) &&
            !NON_TPD_SET.includes(key)) {
            // TODO: Check this on gnome-shell reload.
            if (this._switchMethod !== Lib.METHOD.SYNCLIENT) {
                this.synclient._switch(valTpdEnabled);
            }
            logging('_queueSyncPointingDevice(...) - Already in sync.');
            return;
        }

        switch (key) {
        case KEY_PEN_ENABLED:
            logging('_queueSyncPointingDevice(...): KEY_PEN_ENABLED');
            this.xinput._switchByType(
                'pen', this._extSettings.get_boolean(KEY_PEN_ENABLED));
            break;
        case KEY_FTH_ENABLED:
            logging('_queueSyncPointingDevice(...): KEY_FTH_ENABLED');
            this.xinput._switchByType(
                'fingertouch', this._extSettings.get_boolean(KEY_FTH_ENABLED));
            break;
        case KEY_TSN_ENABLED:
            logging('_queueSyncPointingDevice(...): KEY_TSN_ENABLED');
            this.xinput._switchByType(
                'touchscreen', this._extSettings.get_boolean(KEY_TSN_ENABLED));
            break;
        case KEY_TPT_ENABLED:
            logging('_queueSyncPointingDevice(...): KEY_TPT_ENABLED');
            this.xinput._switchByType(
                'trackpoint', this._extSettings.get_boolean(KEY_TPT_ENABLED));
            break;
        // Touchpad enabled/disabled through SCHEMA_EXTENSION `touchpad-enabled`
        case KEY_TPD_ENABLED:
            logging('_queueSyncPointingDevice(...): KEY_TPD_ENABLED');
            this._syncTouchpad(valTpdEnabled, valSendEvents, isGconfInSync);
            break;
        // Touchpad enabled/disabled through SCHEMA_TOUCHPAD `send-events`
        default:
            logging('_queueSyncPointingDevice(...): default');
            this._onsetSendEvents(valTpdEnabled, valSendEvents);
        }

        if (this._switchMethodChanged === true) {
            this._switchMethodChanged = false;
        }
    }

    _syncTouchpad(valTpdEnabled, valSendEvents, isGconfInSync) {
        logging(`_syncTouchpad(${valTpdEnabled}, ${valSendEvents}, ${isGconfInSync})`);

        // NOTE: When extension's `touchpad-enabled` key is changed, always
        //       sync this change on to the system's `send-events` key, then
        //       procceed to enable/disable touchpad through the current
        //       switch method (if need be).
        switch (this._switchMethod) {
        case Lib.METHOD.GSETTINGS:
            logging('_syncTouchpad(...): Lib.METHOD.GSETTINGS');
            this._onsetTouchpadEnable(valTpdEnabled, valSendEvents);
            break;
        case Lib.METHOD.XINPUT:
            logging('_syncTouchpad(...): Lib.METHOD.XINPUT');
            if (isGconfInSync === false) {
                this._onsetTouchpadEnable(valTpdEnabled, valSendEvents);
            }
            this.xinput._switchByType('touchpad', valTpdEnabled);
            if ((valTpdEnabled === false) &&
                !this.xinput._isPresent('touchpad')) {
                this._extSettings.set_boolean(KEY_TPD_ENABLED, true);
            }
            break;
        case Lib.METHOD.SYNCLIENT:
            logging('_syncTouchpad(...): Lib.METHOD.SYNCLIENT');
            if (isGconfInSync === false) {
                this._onsetTouchpadEnable(valTpdEnabled, valSendEvents);
            }
            this.synclient._switch(valTpdEnabled);
            if ((valTpdEnabled === false) &&
                !this.synclient.tpdOff) {
                this._extSettings.set_boolean(KEY_TPD_ENABLED, true);
            }
            break;
        }
    }

    _onsetSendEvents(valTpdEnabled, valSendEvents) {
        logging(`_onsetSendEvents(${valTpdEnabled}, ${valSendEvents})`);

        // `send-events` is OFF / not ON; `touchpad-enabled` is ON
        //  set `touchpad-enabled` to OFF
        if ((valSendEvents !== 'enabled') && (valTpdEnabled !== false)) {
            logging('_onsetSendEvents(...): set `touchpad-enabled` to false');
            this._extSettings.set_boolean(KEY_TPD_ENABLED, false);
            return;
        }
        // `send-events` is ON; `touchpad-enabled` is OFF
        //  set `touchpad-enabled` to ON
        if ((valSendEvents === 'enabled') && (valTpdEnabled === false)) {
            // Reset if touchpad was externally enabled through gsettings
            // and extension switch method is other than gconf.
            if (this._switchMethod !== Lib.METHOD.GSETTINGS) {
                this.xinput._enableByType('touchpad');
                this.synclient._enable();
            }
            logging('_onsetSendEvents(...): set `touchpad-enabled` to true');
            this._extSettings.set_boolean(KEY_TPD_ENABLED, true);
        }
    }

    _onsetTouchpadEnable(valTpdEnabled, valSendEvents) {
        logging(`_onsetTouchpadEnable(${valTpdEnabled}, ${valSendEvents})`);

        // `touchpad-enabled` is ON; `send-events` is OFF / not ON;
        //  set `send-events` to ON
        if ((valTpdEnabled === true) && (valSendEvents !== 'enabled')) {
            logging('_onsetTouchpadEnable(...): set `send-events` to enabled');
            this._tpdSettings.set_string(KEY_SEND_EVENTS, 'enabled');
            return;
        }
        // `touchpad-enabled` is OFF; `send-events` is ON / not OFF;
        //  set `send-events` to OFF
        if ((valTpdEnabled === false) && (valSendEvents !== 'disabled')) {
            logging('_onsetTouchpadEnable(...): set `send-events` to disabled');
            this._tpdSettings.set_string(KEY_SEND_EVENTS, 'disabled');
        }
    }

    _makeNotification(forType) {
        if (this._extSettings.get_boolean(KEY_NOTIFS_SHOW)) {
            let valSendEvents = this._tpdSettings.get_string(KEY_SEND_EVENTS);
            let valTpdEnabled = this._extSettings.get_boolean(KEY_TPD_ENABLED);

            if (valSendEvents === 'enabled' && valTpdEnabled) {
                this._notify('dialog-information',
                    `${_('Touchpad Indicator')} ${Me.uuid}`,
                    `${_(forType)} ${_('Enabled')}`);
            } else {
                this._notify('dialog-information',
                    `${_('Touchpad Indicator')} ${Me.uuid}`,
                    `${_(forType)} ${_('Disabled')}`);
            }
        }
    }

    _toggleTouchpadEnable() {
        this._extSettings.set_boolean(
            KEY_TPD_ENABLED,
            !this._extSettings.get_boolean(KEY_TPD_ENABLED));
    }

    _addKeybinding() {
        // TODO: Simplify setup of custom keyboard shortcut.
        //       issues/23#issuecomment-504754287, https://git.io/fjwX2
        let shortcut = this._extSettings.get_strv('toggle-touchpad');
        this._extSettings.set_strv('toggle-touchpad', shortcut);
        Main.wm.addKeybinding('toggle-touchpad', this._extSettings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this._toggleTouchpadEnable.bind(this));
    }

    _removeKeybinding() {
        Main.wm.removeKeybinding('toggle-touchpad');
    }

    _updateIcon() {
        let valTpdEnabled = this._extSettings.get_boolean(KEY_TPD_ENABLED);
        this.icon.icon_name = valTpdEnabled ?
            ICON_ENABLED : 'touchpad-disabled-symbolic';
    }

    _onDevicePlugged(filemonitor, file, otherFile, eventType) {
        logging(`_onDevicePlugged(...): ${file.get_path()} ${eventType}`);

        if (file.get_path().indexOf('mouse') !== -1) {
            if ((eventType > 1) && (eventType < 4)) {
                this._onMouseDevicePlugged(eventType);
            }
        }
    }

    _onMouseDevicePlugged(eventType) {
        logging(`_onMouseDevicePlugged(${eventType})`);

        // TODO: Check auto switch behaviour on resume from sleep, restart.
        // TODO: Consider autoswitch-* key was set to 'false' while touchpad
        //       is disabled and then user unplugs the mouse.
        if (this._extSettings.get_boolean('autoswitch-touchpad')) {
            let pointingDevices = Lib.listPointingDevices()[1];
            let mouseDevices = pointingDevices.filter(p => p.type === 'mouse');
            let mouseCount = mouseDevices.length;

            logging(`_onMouseDevicePlugged(${eventType}) - mouseCount is ${mouseCount}`);

            // no mouse device(s) is/are plugged in
            if (eventType === 2 && 
                mouseCount <= this._extSettings.get_int(KEY_MOUSECOUNT) &&
                !this._extSettings.get_boolean(KEY_TPD_ENABLED)) {
                this._extSettings.set_boolean(KEY_TPD_ENABLED, true);
                this._makeNotification('Touchpad');
                return;
            }
            // mouse device(s) is/are plugged in
            if (eventType === 3 && 
                mouseCount > this._extSettings.get_int(KEY_MOUSECOUNT) &&
                this._extSettings.get_boolean(KEY_TPD_ENABLED)) {
                this._extSettings.set_boolean(KEY_TPD_ENABLED, false);
                this._makeNotification('Touchpad');
            }
        }
    }

    _onDebugSignal() {
        this._debug = this._extSettings.get_boolean('debug');
        Lib.DEBUG = this._debug;
        this._debugToFile = this._extSettings.get_boolean('debug-to-file');
        Lib.DEBUG_TO_FILE = this._debugToFile;

        if (this._debug && this._debugToFile) {
            Lib.createLogFile();
        }
    }

    _disconnectSignals() {
        this._watchDevInput.disconnect(this._watchDevInputSignal);
        this._watchDevInput.cancel();
        for (let i = 0; i < this._enabledSignals.length; i++) {
            this._extSettings.disconnect(this._enabledSignals[i]);
        }
        this._extSettings.disconnect(this._keyDebugToFileSignal);
        this._extSettings.disconnect(this._keyDebugSignal);
        this._extSettings.disconnect(this._keySwitchMthdSignal);
        this._extSettings.disconnect(this._keyAlwaysShowSignal);
        this._tpdSettings.disconnect(this._tpdSendEventsSignal);

        this._extSettings.disconnect(this._logEKeyChangeSignal);
        this._tpdSettings.disconnect(this._logSKeyChangeSignal);
    }

    // Make sure to enable related config when extension is disabled
    _resetConfig() {
        logging('_resetConfig');
        // TODO: Let user set program exit touchpad state
        //       None, Enabled, Disabled
        this.synclient._enable();
        this.xinput._enableAll();

        this._tpdSettings.set_string(KEY_SEND_EVENTS, 'enabled');
    }
});

function init() {
    ExtensionUtils.initTranslations();
}

let _indicator;

function enable() {
    logging('enable()');

    _indicator = new TouchpadIndicator;
    Main.panel.addToStatusArea('touchpad-indicator', _indicator);
}

function disable() {
    logging('disable()');
    // NOTE: This is called when activating Lock Screen (eg. Super+L) besides
    //       when explicitly disabling the extension eg. through Tweak Tool.
    _indicator._disconnectSignals();
    _indicator._removeKeybinding();
    _indicator._resetConfig();
    _indicator.destroy();
}


/* exported init enable disable*/