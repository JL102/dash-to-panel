/*
 * This file is part of the Dash-To-Panel extension for Gnome 3
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * Credits:
 * This file is based on code from the Dash to Dock extension by micheleg
 * and code from the Taskbar extension by Zorin OS
 * 
 * Code to re-anchor the panel was taken from Thoma5 BottomPanel:
 * https://github.com/Thoma5/gnome-shell-extension-bottompanel
 * 
 * Pattern for moving clock based on Frippery Move Clock by R M Yorston
 * http://frippery.org/extensions/
 * 
 * Some code was also adapted from the upstream Gnome Shell source code.
 */

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Clutter = imports.gi.Clutter;
const Config = imports.misc.config;
const Gtk = imports.gi.Gtk;
const Gi = imports._gi;
const AppIcons = Me.imports.appIcons;
const Utils = Me.imports.utils;
const Taskbar = Me.imports.taskbar;
const Pos = Me.imports.panelPositions;
const PanelStyle = Me.imports.panelStyle;
const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Dash = imports.ui.dash;
const CtrlAltTab = imports.ui.ctrlAltTab;
const Panel = imports.ui.panel;
const PanelMenu = imports.ui.panelMenu;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const DND = imports.ui.dnd;
const Shell = imports.gi.Shell;
const PopupMenu = imports.ui.popupMenu;
const IconGrid = imports.ui.iconGrid;
const ViewSelector = imports.ui.viewSelector;
const DateMenu = imports.ui.dateMenu;
const Volume = imports.ui.status.volume;
const Progress = Me.imports.progress;

const Intellihide = Me.imports.intellihide;
const Transparency = Me.imports.transparency;
const _ = imports.gettext.domain(Me.imports.utils.TRANSLATION_DOMAIN).gettext;

let tracker = Shell.WindowTracker.get_default();
var panelBoxes = ['_leftBox', '_centerBox', '_rightBox'];
var sizeFunc;
var fixedCoord;
var varCoord;
var size;

//timeout names
const T1 = 'startDynamicTransparencyTimeout';
const T2 = 'startIntellihideTimeout';
const T3 = 'allocationThrottleTimeout';
const T4 = 'showDesktopTimeout';
const T5 = 'trackerFocusAppTimeout';
const T6 = 'scrollPanelDelayTimeout';
const T7 = 'waitPanelBoxAllocation';

function getPosition() {
    let position = Me.settings.get_string('panel-position');
    
    if (position == 'TOP') {
        return St.Side.TOP;
    } else if (position == 'RIGHT') {
        return St.Side.RIGHT;
    } else if (position == 'BOTTOM') {
        return St.Side.BOTTOM;
    }
    
    return St.Side.LEFT;
}

function checkIfVertical() {
    let position = getPosition();

    return (position == St.Side.LEFT || position == St.Side.RIGHT);
}

function getOrientation() {
    return (checkIfVertical() ? 'vertical' : 'horizontal');
}

function setMenuArrow(arrowIcon, side) {
    let parent = arrowIcon.get_parent();
    let iconNames = {
        '0': 'pan-down-symbolic',   //TOP
        '1': 'pan-start-symbolic',  //RIGHT
        '2': 'pan-up-symbolic',     //BOTTOM
        '3': 'pan-end-symbolic'     //LEFT
    };

    parent.remove_child(arrowIcon);
    arrowIcon.set_icon_name(iconNames[side]);
    parent.add_child(arrowIcon);
}

var dtpPanel = Utils.defineClass({
    Name: 'DashToPanel-Panel',
    Extends: St.Widget,

    _init: function(panelManager, monitor, panelBox, isStandalone) {
        let position = getPosition();
        
        this.callParent('_init', { layout_manager: new Clutter.BinLayout() });

        this._timeoutsHandler = new Utils.TimeoutsHandler();
        this._signalsHandler = new Utils.GlobalSignalsHandler();

        this.panelManager = panelManager;
        this.panelStyle = new PanelStyle.dtpPanelStyle();

        this.monitor = monitor;
        this.panelBox = panelBox;

        // when the original gnome-shell top panel is kept, all panels are "standalone",
        // so in this case use isPrimary to get the panel on the primary dtp monitor, which
        // might be different from the system's primary monitor.
        this.isStandalone = isStandalone;
        this.isPrimary = !isStandalone || (Me.settings.get_boolean('stockgs-keep-top-panel') && 
                                           monitor == panelManager.dtpPrimaryMonitor);

        this._sessionStyle = null;
        this._unmappedButtons = [];
        this.cornerSize = 0;

        if (isStandalone) {
            this.panel = new St.Widget({ name: 'panel', reactive: true });
            this.statusArea = this.panel.statusArea = {};

            Utils.wrapActor(this.panel);

            //next 3 functions are needed by other extensions to add elements to the secondary panel
            this.panel.addToStatusArea = function(role, indicator, position, box) {
                return Main.panel.addToStatusArea.call(this, role, indicator, position, box);
            };

            this.panel._addToPanelBox = function(role, indicator, position, box) {
                Main.panel._addToPanelBox.call(this, role, indicator, position, box);
            };

            this.panel._onMenuSet = function(indicator) {
                Main.panel._onMenuSet.call(this, indicator);
            };

            this._leftBox = this.panel._leftBox = new St.BoxLayout({ name: 'panelLeft' });
            this._centerBox = this.panel._centerBox = new St.BoxLayout({ name: 'panelCenter' });
            this._rightBox = this.panel._rightBox = new St.BoxLayout({ name: 'panelRight' });

            this.menuManager = this.panel.menuManager = new PopupMenu.PopupMenuManager(this.panel);

            this._setPanelMenu('aggregateMenu', dtpSecondaryAggregateMenu, this.panel.actor);
            this._setPanelMenu('dateMenu', DateMenu.DateMenuButton, this.panel.actor);
            this._setPanelMenu('activities', Panel.ActivitiesButton, this.panel.actor);

            if (this.statusArea.aggregateMenu) {
                setMenuArrow(this.statusArea.aggregateMenu._indicators.get_last_child(), position);
            }

            this.panel.add_child(this._leftBox);
            this.panel.add_child(this._centerBox);
            this.panel.add_child(this._rightBox);
        } else {
            this.panel = Main.panel;
            this.statusArea = Main.panel.statusArea;
            this.menuManager = Main.panel.menuManager;

            setMenuArrow(this.statusArea.aggregateMenu._indicators.get_last_child(), position);

            panelBoxes.forEach(p => this[p] = Main.panel[p]);

            this._leftBox.remove_child(this.statusArea.activities.container);
            this.panel.actor.add_child(this.statusArea.activities.container);

            this._rightBox.remove_child(this.statusArea.aggregateMenu.container);
            this.panel.actor.add_child(this.statusArea.aggregateMenu.container);

            this._centerBox.remove_child(this.statusArea.dateMenu.container);
            this.panel.actor.add_child(this.statusArea.dateMenu.container);
        }

        // Create a wrapper around the real showAppsIcon in order to add a popupMenu. Most of 
        // its behavior is handled by the taskbar, but its positioning is done at the panel level
        this.showAppsIconWrapper = new AppIcons.ShowAppsIconWrapper();
        this.showAppsIconWrapper._dtpPanel = this;
        this.panel.actor.add_child(this.showAppsIconWrapper.realShowAppsIcon);

        this.panel.actor._delegate = this;
        
        if (position == St.Side.TOP) {
            this.panel._leftCorner = this.panel._leftCorner || new Panel.PanelCorner(St.Side.LEFT);
            this.panel._rightCorner = this.panel._rightCorner || new Panel.PanelCorner(St.Side.RIGHT);
        }

        Utils.wrapActor(this.panel._leftCorner || 0);
        Utils.wrapActor(this.panel._rightCorner || 0);

        if (isStandalone && position == St.Side.TOP) {
            this.panel.actor.add_child(this.panel._leftCorner.actor);
            this.panel.actor.add_child(this.panel._rightCorner.actor);
            this.panel._rightCorner.setStyleParent(this.panel.actor);
        }

        this.add_child(this.panel.actor);

        if (Main.panel._onButtonPress || Main.panel._tryDragWindow) {
            this._signalsHandler.add([
                this.panel.actor, 
                [
                    'button-press-event', 
                    'touch-event'
                ],
                this._onButtonPress.bind(this)
            ]);
        }

        if (Main.panel._onKeyPress) {
            this._signalsHandler.add([this.panel.actor, 'key-press-event', Main.panel._onKeyPress.bind(this)]);
        }
       
        Main.ctrlAltTabManager.addGroup(this, _("Top Bar")+" "+ monitor.index, 'focus-top-bar-symbolic',
                                        { sortGroup: CtrlAltTab.SortGroup.TOP });
    },

    enable : function() {
        let position = getPosition();

        if (this.statusArea.aggregateMenu) {
            Utils.getIndicators(this.statusArea.aggregateMenu._volume)._dtpIgnoreScroll = 1;
        }

        this.geom = this.getGeometry();
        
        // The overview uses the panel height as a margin by way of a "ghost" transparent Clone
        // This pushes everything down, which isn't desired when the panel is moved to the bottom
        // I'm adding a 2nd ghost panel and will resize the top or bottom ghost depending on the panel position
        this._myPanelGhost = new Clutter.Actor({ 
            x: this.geom.x,
            y: this.geom.y ,
            reactive: false, 
            opacity: 0
        });

        if (this.geom.position == St.Side.TOP) {
            Main.overview._overview.insert_child_at_index(this._myPanelGhost, 0);
        } else {
            let overviewControls = Main.overview._overview._controls || Main.overview._controls;
            
             if (this.geom.position == St.Side.BOTTOM) {
                Main.overview._overview.add_actor(this._myPanelGhost);
            } else if (this.geom.position == St.Side.LEFT) {
                overviewControls._group.insert_child_at_index(this._myPanelGhost, 0);
            } else {
                overviewControls._group.add_actor(this._myPanelGhost);
            }
        }

        this._setPanelPosition();

        if (!this.isStandalone) {
            if (this.panel.vfunc_allocate) {
                this._panelConnectId = 0;
                Utils.hookVfunc(this.panel.__proto__, 'allocate', (box, flags) => this._mainPanelAllocate(0, box, flags));
            } else {
                this._panelConnectId = this.panel.actor.connect('allocate', (actor, box, flags) => this._mainPanelAllocate(actor, box, flags));
            }

            // remove the extra space before the clock when the message-indicator is displayed
            if (DateMenu.IndicatorPad) {
                Utils.hookVfunc(DateMenu.IndicatorPad.prototype, 'get_preferred_width', () => [0,0]);
                Utils.hookVfunc(DateMenu.IndicatorPad.prototype, 'get_preferred_height', () => [0,0]);
            }
        }

        if (!DateMenu.IndicatorPad && this.statusArea.dateMenu) {
            //3.36 switched to a size constraint applied on an anonymous child
            let indicatorPad = this.statusArea.dateMenu.get_first_child().get_first_child();

            this._dateMenuIndicatorPadContraints = indicatorPad.get_constraints();
            indicatorPad.clear_constraints();
        }

        // The main panel's connection to the "allocate" signal is competing with this extension
        // trying to move the centerBox over to the right, creating a never-ending cycle.
        // Since we don't have the ID to disconnect that handler, wrap the allocate() function 
        // it calls instead. If the call didn't originate from this file, ignore it.
        panelBoxes.forEach(b => {
            this[b].allocate = (box, flags, isFromDashToPanel) => {
                if (isFromDashToPanel) {
                    this[b].__proto__.allocate.call(this[b], box, flags);
                }
            }
        });

        this.menuManager._oldChangeMenu = this.menuManager._changeMenu;
        this.menuManager._changeMenu = (menu) => {
            if (!Me.settings.get_boolean('stockgs-panelbtn-click-only')) {
                this.menuManager._oldChangeMenu(menu);
            }
        };

        if (this.statusArea.appMenu) {
            setMenuArrow(this.statusArea.appMenu._arrow, position);
            this._leftBox.remove_child(this.statusArea.appMenu.container);
        }

        if (this.statusArea.keyboard) {
            setMenuArrow(this.statusArea.keyboard._hbox.get_last_child(), position);
        }

        this.dynamicTransparency = new Transparency.DynamicTransparency(this);
        
        this.taskbar = new Taskbar.taskbar(this);

        this.panel.actor.add_child(this.taskbar.actor);

        this._setAppmenuVisible(Me.settings.get_boolean('show-appmenu'));
        this._setShowDesktopButton(true);
        
        this._setAllocationMap();

        this._setRightCornerStyle();
        
        this.panel.actor.add_style_class_name('dashtopanelMainPanel ' + getOrientation());

        // Since Gnome 3.8 dragging an app without having opened the overview before cause the attemp to
        //animate a null target since some variables are not initialized when the viewSelector is created
        if(Main.overview.viewSelector._activePage == null)
            Main.overview.viewSelector._activePage = Main.overview.viewSelector._workspacesPage;

        this._setPanelGhostSize();

        this._timeoutsHandler.add([T2, Me.settings.get_int('intellihide-enable-start-delay'), () => this.intellihide = new Intellihide.Intellihide(this)]);

        this._signalsHandler.add(
            // this is to catch changes to the theme or window scale factor
            [
                Utils.getStageTheme(), 
                'changed', 
                () => this._resetGeometry()
            ],
            [
                // sync hover after a popupmenu is closed
                this.taskbar,
                'menu-closed', 
                Lang.bind(this, function(){this.panel.actor.sync_hover();})
            ],
            [
                Main.overview,
                [
                    'showing',
                    'hiding'
                ],
                () => this._adjustForOverview()
            ],
            [
                this._centerBox,
                'actor-added',
                () => this._onBoxActorAdded(this._centerBox)
            ],
            [
                this._rightBox,
                'actor-added',
                () => this._onBoxActorAdded(this._rightBox)
            ],
            [
                this.panel.actor,
                'scroll-event',
                this._onPanelMouseScroll.bind(this)
            ],
            [
                Main.layoutManager,
                'startup-complete',
                () => this._resetGeometry()
            ]
        );

        this._bindSettingsChanges();

        this.panelStyle.enable(this);

        if (checkIfVertical()) {
            this._signalsHandler.add([
                this.panelBox,
                'notify::visible',
                () => {
                    if (this.panelBox.visible) {
                        this._refreshVerticalAlloc();
                    }
                }
            ]);

            this._setSearchEntryOffset(this.geom.w);

            if (this.statusArea.dateMenu) {
                this._formatVerticalClock();
                
                this._signalsHandler.add([
                    this.statusArea.dateMenu._clock,
                    'notify::clock',
                    () => this._formatVerticalClock()
                ]);
            }
        }

        // Since we are usually visible but not usually changing, make sure
        // most repaint requests don't actually require us to repaint anything.
        // This saves significant CPU when repainting the screen.
        this.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

        this._initProgressManager();
    },

    disable: function () {
        this.panelStyle.disable();

        this._timeoutsHandler.destroy();
        this._signalsHandler.destroy();
        this.panel.remove_child(this.taskbar.actor);
        this._setAppmenuVisible(false);

        if (this.intellihide) {
            this.intellihide.destroy();
        }

        this.dynamicTransparency.destroy();

        this.progressManager.destroy();

        this.taskbar.destroy();
        this.showAppsIconWrapper.destroy();

        this.menuManager._changeMenu = this.menuManager._oldChangeMenu;

        this._myPanelGhost.get_parent().remove_actor(this._myPanelGhost);
        this._setSearchEntryOffset(0);
        
        panelBoxes.forEach(b => delete this[b].allocate);
        this._unmappedButtons.forEach(a => this._disconnectVisibleId(a));

        if (this._dateMenuIndicatorPadContraints && this.statusArea.dateMenu) {
            let indicatorPad = this.statusArea.dateMenu.get_first_child().get_first_child();

            this._dateMenuIndicatorPadContraints.forEach(c => indicatorPad.add_constraint(c));
        }

        this._setVertical(this.panel.actor, false);

        if (!this.isStandalone) {
            this.statusArea.dateMenu._clockDisplay.text = this.statusArea.dateMenu._clock.clock;

            ['vertical', 'horizontal', 'dashtopanelMainPanel'].forEach(c => this.panel.actor.remove_style_class_name(c));

            if (!Main.sessionMode.isLocked) {
                this.panel.remove_child(this.statusArea.activities.container);
                this._leftBox.insert_child_at_index(this.statusArea.activities.container, 0);

                this.panel.remove_child(this.statusArea.dateMenu.container);
                this._centerBox.insert_child_at_index(this.statusArea.dateMenu.container, 0);

                this.panel.remove_child(this.statusArea.aggregateMenu.container);
                this._rightBox.add_child(this.statusArea.aggregateMenu.container);
                
                if (this.statusArea.appMenu) {
                    setMenuArrow(this.statusArea.appMenu._arrow, St.Side.TOP);
                    this._leftBox.add_child(this.statusArea.appMenu.container);
                }

                if (this.statusArea.keyboard) {
                    setMenuArrow(this.statusArea.keyboard._hbox.get_last_child(), St.Side.TOP);
                }
            }

            this._setShowDesktopButton(false);

            this._toggleCornerStyle(this.panel._leftCorner, true);
            this._toggleCornerStyle(this.panel._rightCorner, true);

            delete Utils.getIndicators(this.statusArea.aggregateMenu._volume)._dtpIgnoreScroll;
            setMenuArrow(this.statusArea.aggregateMenu._indicators.get_last_child(), St.Side.TOP);

            if (DateMenu.IndicatorPad) {
                Utils.hookVfunc(DateMenu.IndicatorPad.prototype, 'get_preferred_width', DateMenu.IndicatorPad.prototype.vfunc_get_preferred_width);
                Utils.hookVfunc(DateMenu.IndicatorPad.prototype, 'get_preferred_height', DateMenu.IndicatorPad.prototype.vfunc_get_preferred_height);
            }

            if (this._panelConnectId) {
                this.panel.actor.disconnect(this._panelConnectId);
            } else {
                Utils.hookVfunc(this.panel.__proto__, 'allocate', this.panel.__proto__.vfunc_allocate);
            }
            
            this.panel.actor._delegate = this.panel;
        } else {
            this._removePanelMenu('dateMenu');
            this._removePanelMenu('aggregateMenu');
            this._removePanelMenu('activities');

            if (this.panel._rightCorner && this.panel._rightCorner._buttonStyleChangedSignalId) {
                this.panel._rightCorner._button.disconnect(this.panel._rightCorner._buttonStyleChangedSignalId);
            }
        }

        Main.ctrlAltTabManager.removeGroup(this);
    },

    handleDragOver: function(source, actor, x, y, time) {
        if (source == Main.xdndHandler) {
            
            // open overview so they can choose a window for focusing
            // and ultimately dropping dragged item onto
            if(Main.overview.shouldToggleByCornerOrButton())
                Main.overview.show();
        }
        
        return DND.DragMotionResult.CONTINUE;
    },

    updateElementPositions: function() {
        this._getElementPositions().forEach(pos => {
            let actor = this.allocationMap[pos.element].actor;

            if (actor) {
                actor.visible = pos.visible;
            }
        });

        this.panel.actor.hide();
        this.panel.actor.show();
    },

    _getElementPositions: function() {
        return this.panelManager.panelsElementPositions[this.monitor.index] || Pos.defaults;
    },

    _bindSettingsChanges: function() {
        let isVertical = checkIfVertical();
        
        this._signalsHandler.add(
            [
                Me.settings,
                [
                    'changed::panel-size',
                    'changed::group-apps'
                ],
                () => this._resetGeometry()
            ],
            [
                Me.settings,
                [
                    'changed::appicon-margin',
                    'changed::appicon-padding'
                ],
                () => this.taskbar.resetAppIcons()
            ],
            [
                Me.settings,
                'changed::show-appmenu',
                () => this._setAppmenuVisible(Me.settings.get_boolean('show-appmenu'))
            ],
            [
                Me.settings,
                'changed::showdesktop-button-width',
                () => this._setShowDesktopButtonSize()
            ],
            [
                Me.desktopSettings,
                'changed::clock-format',
                () => {
                    this._clockFormat = null;
                    
                    if (isVertical) {
                        this._formatVerticalClock();
                    }
                }
            ],
            [
                Me.settings,
                'changed::progress-show-bar',
                () => this._initProgressManager()
            ],
            [
                Me.settings,
                'changed::progress-show-count',
                () => this._initProgressManager()
            ]
        );

        if (isVertical) {
            this._signalsHandler.add([Me.settings, 'changed::group-apps-label-max-width', () => this._resetGeometry()]);
        }
    },

    _setPanelMenu: function(propName, constr, container) {
        if (!this.statusArea[propName]) {
            this.statusArea[propName] = this._getPanelMenu(propName, constr);
            this.menuManager.addMenu(this.statusArea[propName].menu);
            container.insert_child_at_index(this.statusArea[propName].container, 0);
        }
    },
    
    _removePanelMenu: function(propName) {
        if (this.statusArea[propName]) {
            let parent = this.statusArea[propName].container.get_parent();

            if (parent) {
                parent.remove_actor(this.statusArea[propName].container);
            }

            //calling this.statusArea[propName].destroy(); is buggy for now, gnome-shell never
            //destroys those panel menus...
            //since we can't destroy the menu (hence properly disconnect its signals), let's 
            //store it so the next time a panel needs one of its kind, we can reuse it instead 
            //of creating a new one
            let panelMenu = this.statusArea[propName];

            this.menuManager.removeMenu(panelMenu.menu);
            Me.persistentStorage[propName].push(panelMenu);
            this.statusArea[propName] = null;
        }
    },

    _getPanelMenu: function(propName, constr) {
        Me.persistentStorage[propName] = Me.persistentStorage[propName] || [];

        if (!Me.persistentStorage[propName].length) {
            Me.persistentStorage[propName].push(new constr());
        }

        return Me.persistentStorage[propName].pop();
    },

    _setPanelGhostSize: function() {
        this._myPanelGhost.set_size(this.width, checkIfVertical() ? 1 : this.height); 
    },

    _setSearchEntryOffset: function(offset) {
        if (this.isPrimary) {
            //In the overview, when the panel is vertical the search-entry is the only element
            //that doesn't natively take into account the size of a side dock, as it is always
            //centered relatively to the monitor. This looks misaligned, adjust it here so it 
            //is centered like the rest of the overview elements.
            let paddingSide = getPosition() == St.Side.LEFT ? 'left' : 'right';
            let scaleFactor = Utils.getScaleFactor();
            let style = offset ? 'padding-' + paddingSide + ':' + (offset / scaleFactor) + 'px;' : null;
            let searchEntry = Main.overview._searchEntry || Main.overview._overview._searchEntry;
            
            searchEntry.get_parent().set_style(style);
        }
    },

    _adjustForOverview: function() {
        let isFocusedMonitor = this.panelManager.checkIfFocusedMonitor(this.monitor);
        let isOverview = !!Main.overview.visibleTarget;
        let isOverviewFocusedMonitor = isOverview && isFocusedMonitor;
        let isShown = !isOverview || isOverviewFocusedMonitor;

        this.panelBox[isShown ? 'show' : 'hide']();

        if (isOverview) {
            this._myPanelGhost[isOverviewFocusedMonitor ? 'show' : 'hide']();

            if (isOverviewFocusedMonitor) {
                Utils.getPanelGhost().set_size(1, this.geom.position == St.Side.TOP ? 0 : 32);
            }
        }
    },

    _resetGeometry: function() {
        this.geom = this.getGeometry();
        this._setPanelGhostSize();
        this._setPanelPosition();
        this.taskbar.resetAppIcons(true);
        this.dynamicTransparency.updateExternalStyle();

        if (this.intellihide && this.intellihide.enabled) {
            this.intellihide.reset();
        }

        if (checkIfVertical()) {
            this.showAppsButton.set_width(this.geom.w);
            this._refreshVerticalAlloc();
            this._setSearchEntryOffset(this.geom.w);
        }
    },

    getGeometry: function() {
        let scaleFactor = Utils.getScaleFactor();
        let panelBoxTheme = this.panelBox.get_theme_node();
        let lrPadding = panelBoxTheme.get_padding(St.Side.RIGHT) + panelBoxTheme.get_padding(St.Side.LEFT);
        let topPadding = panelBoxTheme.get_padding(St.Side.TOP);
        let tbPadding = topPadding + panelBoxTheme.get_padding(St.Side.BOTTOM);
        let position = getPosition();
        let gsTopPanelOffset = 0;
        let x = 0, y = 0;
        let w = 0, h = 0;

        size = Me.settings.get_int('panel-size') * scaleFactor;

        if (Me.settings.get_boolean('stockgs-keep-top-panel') && Main.layoutManager.primaryMonitor == this.monitor) {
            gsTopPanelOffset = Main.layoutManager.panelBox.height - topPadding;
        }

        if (checkIfVertical()) {
            if (!Me.settings.get_boolean('group-apps')) {
                // add window title width and side padding of _dtpIconContainer when vertical
                size += Me.settings.get_int('group-apps-label-max-width') + AppIcons.DEFAULT_PADDING_SIZE * 2 / scaleFactor;
            }

            sizeFunc = 'get_preferred_height',
            fixedCoord = { c1: 'x1', c2: 'x2' },
            varCoord = { c1: 'y1', c2: 'y2' };

            w = size;
            h = this.monitor.height - tbPadding - gsTopPanelOffset;
        } else {
            sizeFunc = 'get_preferred_width';
            fixedCoord = { c1: 'y1', c2: 'y2' };
            varCoord = { c1: 'x1', c2: 'x2' };

            w = this.monitor.width - lrPadding;
            h = size;
        }

        if (position == St.Side.TOP || position == St.Side.LEFT) {
            x = this.monitor.x;
            y = this.monitor.y + gsTopPanelOffset;
        } else if (position == St.Side.RIGHT) {
            x = this.monitor.x + this.monitor.width - size - lrPadding;
            y = this.monitor.y + gsTopPanelOffset;
        } else { //BOTTOM
            x = this.monitor.x; 
            y = this.monitor.y + this.monitor.height - size - tbPadding;
        }

        return {
            x: x, y: y, 
            w: w, h: h,
            lrPadding: lrPadding,
            tbPadding: tbPadding,
            position: position
        };
    },

    _setAllocationMap: function() {
        this.allocationMap = {};
        let setMap = (name, actor, isBox) => this.allocationMap[name] = { 
            actor: actor,
            isBox: isBox || 0,
            box: new Clutter.ActorBox() 
        };
        
        setMap(Pos.SHOW_APPS_BTN, this.showAppsIconWrapper.realShowAppsIcon);
        setMap(Pos.ACTIVITIES_BTN, this.statusArea.activities ? this.statusArea.activities.container : 0);
        setMap(Pos.LEFT_BOX, this._leftBox, 1);
        setMap(Pos.TASKBAR, this.taskbar.actor);
        setMap(Pos.CENTER_BOX, this._centerBox, 1);
        setMap(Pos.DATE_MENU, this.statusArea.dateMenu.container);
        setMap(Pos.SYSTEM_MENU, this.statusArea.aggregateMenu.container);
        setMap(Pos.RIGHT_BOX, this._rightBox, 1);
        setMap(Pos.DESKTOP_BTN, this._showDesktopButton);
    },

    _mainPanelAllocate: function(actor, box, flags) {
        this.panel.actor.set_allocation(box, flags);
    },

    vfunc_allocate: function(box, flags) {
        this.set_allocation(box, flags);

        this.panel.actor.allocate(new Clutter.ActorBox({ x1: 0, y1: 0, x2: this.geom.w, y2: this.geom.h }), flags);

        let panelAllocVarSize = box[varCoord.c2] - box[varCoord.c1];
        let elements = [];
        let centerMonitorElements = [];
        let fixed = 0;
        let checkIfCentered = element => element.position == Pos.CENTERED || element.position == Pos.CENTERED_MONITOR;
        let allocateCenter = (centeredElements, trLimit, brLimit) => {
            if (centeredElements.length) {
                centeredElements.filter(c => c.hasDynamicSize).forEach(c => adjustDynamicSize(c));

                let centeredWidth = centeredElements.reduce((size, c) => size + c.natSize, 0);
                let tlOffset = Math.max(0, Math.round((brLimit - trLimit - centeredWidth) * .5));

                centeredElements.forEach(c => {
                    allocate(c, trLimit + tlOffset);
                    trLimit += c.natSize;
                });
            }
        };
        let allocate = (element, c1) => {
            element.box[varCoord.c1] = Math.max(0, Math.min(panelAllocVarSize, c1));
            element.box[varCoord.c2] = Math.max(element.natSize, Math.min(panelAllocVarSize, element.box[varCoord.c1] + element.natSize));
            
            if (element.hasDynamicSize) {
                adjustDynamicSize(element, true);
            }

            element.fixed = 1;
            ++fixed;

            let params = [element.box, flags];

            if (element.isBox) {
                params.push(1);
            } 

            element.actor.allocate.apply(element.actor, params);
        };
        let adjustDynamicSize = (element, adjustPos) => {
            let isCentered = checkIfCentered(element);
            let getSiblingsInfo = (direction, defaultLimit = 0, unfixedSize = 0, centeredSize = 0, limit = 0) => {
                let j = element.index + direction;
                let refElement = elements[j];

                while (refElement && (!refElement.fixed || (isCentered && refElement.position == element.position))) {
                    if (isCentered && refElement.position == element.position) {
                        centeredSize += refElement.natSize;
                    }
    
                    unfixedSize += refElement.natSize;
                    refElement = elements[(j += direction)];
                }
    
                limit = refElement ? refElement.box[varCoord[direction > 0 ? 'c1' : 'c2']] : defaultLimit;

                return [unfixedSize, centeredSize, limit];
            };
            let [unfixedSizeTl, centeredSizeTl, prevLimit] = getSiblingsInfo(-1);
            let [unfixedSizeBr, centeredSizeBr, nextLimit] = getSiblingsInfo(1, panelAllocVarSize);
            let availableSize = nextLimit - prevLimit - unfixedSizeTl - unfixedSizeBr - 
                                (isCentered ? Math.abs((unfixedSizeTl - centeredSizeTl) - (unfixedSizeBr - centeredSizeBr)) : 0);

            if (availableSize < element.natSize) {
                element.natSize = availableSize;

                if (adjustPos) {
                    element.box[varCoord.c1] = Math.max(prevLimit + unfixedSizeTl, element.box[varCoord.c1]);
                    element.box[varCoord.c2] = Math.min(nextLimit - unfixedSizeBr, element.box[varCoord.c2]);
                }
            }

            element.hasDynamicSize = 0;
        };

        this._getElementPositions().forEach(pos => {
            let element = this.allocationMap[pos.element];
            
            if (element.actor && pos.visible) {
                element.natSize = element.actor[sizeFunc](-1)[1];

                if (element.natSize <= 0) return;

                element.box[fixedCoord.c1] = box[fixedCoord.c1];
                element.box[fixedCoord.c2] = box[fixedCoord.c2];
                element.hasDynamicSize = pos.element == Pos.TASKBAR;
                element.index = elements.length;
                element.position = pos.position;
                element.fixed = 0;

                if (pos.position == Pos.CENTERED_MONITOR && 
                    (!centerMonitorElements.length || elements[element.index - 1].position == Pos.CENTERED_MONITOR)) {
                    centerMonitorElements.push(element);
                }

                elements.push(element);
            }
        });

        allocateCenter(centerMonitorElements, 0, box[varCoord.c2]);

        let iterations = 0; //failsafe
        while (fixed < elements.length && ++iterations < 10) {
            for (let i = 0, l = elements.length; i < l; ++i) {
                if (elements[i].fixed) continue;

                let element = elements[i];
                let prevElement = elements[i - 1];
                let nextElement = elements[i + 1];

                if (element.position == Pos.STACKED_TL && prevElement && prevElement.position == Pos.STACKED_BR) {
                    element.position = Pos.STACKED_BR;
                }

                if (element.position == Pos.STACKED_TL && (!prevElement || prevElement.fixed)) {
                    allocate(element, prevElement ? prevElement.box[varCoord.c2] : 0);
                } else if (element.position == Pos.STACKED_BR && (!nextElement || nextElement.fixed)) {
                    let nextLimit = nextElement ? nextElement.box[varCoord.c1] : panelAllocVarSize;
                    
                    allocate(element, nextLimit - element.natSize);
                } else if (checkIfCentered(element)) { //fallback for non contiguous CENTERED_MONITOR
                    let centeredElements = [element];
                    let j = i;

                    while (prevElement && prevElement.position == Pos.STACKED_BR) {
                        prevElement = elements[--j];
                    }

                    if (prevElement && !prevElement.fixed) continue;

                    while (nextElement && checkIfCentered(nextElement)) {
                        centeredElements.push(nextElement);
                        nextElement = elements[++i + 1];
                    }

                    j = i;
                    while (nextElement && nextElement.position == Pos.STACKED_TL) {
                        nextElement = elements[++j];
                    }

                    if (!nextElement || (nextElement.fixed)) {
                        allocateCenter(
                            centeredElements,
                            prevElement ? prevElement.box[varCoord.c2] : 0,
                            nextElement ? nextElement.box[varCoord.c1] : panelAllocVarSize
                        );
                    }
                }
            }
        }

        if (this.geom.position == St.Side.TOP) {
            let childBoxLeftCorner = new Clutter.ActorBox();
            let childBoxRightCorner = new Clutter.ActorBox();
            let currentCornerSize = this.cornerSize;
            let panelAllocFixedSize = box[fixedCoord.c2] - box[fixedCoord.c1];
            
            [ , this.cornerSize] = this.panel._leftCorner.actor[sizeFunc](-1);
            childBoxLeftCorner[varCoord.c1] = 0;
            childBoxLeftCorner[varCoord.c2] = this.cornerSize;
            childBoxLeftCorner[fixedCoord.c1] = panelAllocFixedSize;
            childBoxLeftCorner[fixedCoord.c2] = panelAllocFixedSize + this.cornerSize;

            childBoxRightCorner[varCoord.c1] = panelAllocVarSize - this.cornerSize;
            childBoxRightCorner[varCoord.c2] = panelAllocVarSize;
            childBoxRightCorner[fixedCoord.c1] = panelAllocFixedSize;
            childBoxRightCorner[fixedCoord.c2] = panelAllocFixedSize + this.cornerSize;

            this.panel._leftCorner.actor.allocate(childBoxLeftCorner, flags);
            this.panel._rightCorner.actor.allocate(childBoxRightCorner, flags);

            if (this.cornerSize != currentCornerSize) {
                this._setPanelClip();
            }
        }
    },

    _setPanelPosition: function() {
        let clipContainer = this.panelBox.get_parent();

        this.set_size(this.geom.w, this.geom.h);
        clipContainer.set_position(this.geom.x, this.geom.y);

        this._setVertical(this.panel.actor, checkIfVertical());

        // styles for theming
        Object.keys(St.Side).forEach(p => {
            let cssName = 'dashtopanel' + p.charAt(0) + p.slice(1).toLowerCase();
            
            this.panel.actor[(St.Side[p] == this.geom.position ? 'add' : 'remove') + '_style_class_name'](cssName);
        });

        this._setPanelClip(clipContainer);

        Main.layoutManager._updateHotCorners();
        Main.layoutManager._updatePanelBarrier(this);
    },

    _setPanelClip: function(clipContainer) {
        clipContainer = clipContainer || this.panelBox.get_parent();
        this._timeoutsHandler.add([T7, 0, () => Utils.setClip(clipContainer, clipContainer.x, clipContainer.y, this.panelBox.width, this.panelBox.height + this.cornerSize)]);
    },

    _onButtonPress: function(actor, event) {
        let type = event.type();
        let isPress = type == Clutter.EventType.BUTTON_PRESS;
        let button = isPress ? event.get_button() : -1;
        let [stageX, stageY] = event.get_coords();

        if (button == 3 && global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, stageX, stageY) == this.panel.actor) {
            //right click on an empty part of the panel, temporarily borrow and display the showapps context menu
            Main.layoutManager.setDummyCursorGeometry(stageX, stageY, 0, 0);

            this.showAppsIconWrapper.createMenu();
            this.showAppsIconWrapper._menu.sourceActor = Main.layoutManager.dummyCursor;
            this.showAppsIconWrapper.popupMenu();

            return Clutter.EVENT_STOP;
        } else if (Main.modalCount > 0 || event.get_source() != actor || 
            (!isPress && type != Clutter.EventType.TOUCH_BEGIN) ||
            (isPress && button != 1)) {
            return Clutter.EVENT_PROPAGATE;
        }

        let params = checkIfVertical() ? [stageY, 'y', 'height'] : [stageX, 'x', 'width'];
        let dragWindow = this._getDraggableWindowForPosition.apply(this, params.concat(['maximized_' + getOrientation() + 'ly']));

        if (!dragWindow)
            return Clutter.EVENT_PROPAGATE;

        global.display.begin_grab_op(dragWindow,
                                     Meta.GrabOp.MOVING,
                                     false, /* pointer grab */
                                     true, /* frame action */
                                     button,
                                     event.get_state(),
                                     event.get_time(),
                                     stageX, stageY);

        return Clutter.EVENT_STOP;
    },

    _getDraggableWindowForPosition: function(stageCoord, coord, dimension, maximizedProp) {
        let workspace = Utils.getCurrentWorkspace();
        let allWindowsByStacking = global.display.sort_windows_by_stacking(
            workspace.list_windows()
        ).reverse();

        return allWindowsByStacking.find(metaWindow => {
            let rect = metaWindow.get_frame_rect();

            return metaWindow.get_monitor() == this.monitor.index &&
                   metaWindow.showing_on_its_workspace() &&
                   metaWindow.get_window_type() != Meta.WindowType.DESKTOP &&
                   metaWindow[maximizedProp] &&
                   stageCoord > rect[coord] && stageCoord < rect[coord] + rect[dimension];
        });
    },

    _onBoxActorAdded: function(box) {
        this._setRightCornerStyle();

        if (checkIfVertical()) {
            this._setVertical(box, true);
        }
    },

    _refreshVerticalAlloc: function() {
        this._setVertical(this._centerBox, true);
        this._setVertical(this._rightBox, true);
        this._formatVerticalClock();
    },

    _setVertical: function(actor, isVertical) {
        let _set = (actor, isVertical) => {
            if (!actor || actor instanceof Dash.DashItemContainer) {
                return;
            }

            if (actor instanceof St.BoxLayout) {
                actor.vertical = isVertical;
            } else if ((actor._delegate || actor) instanceof PanelMenu.ButtonBox && actor != this.statusArea.appMenu) {
                let child = actor.get_first_child();

                if (isVertical && !actor.visible && !actor._dtpVisibleId) {
                    this._unmappedButtons.push(actor);
                    actor._dtpVisibleId = actor.connect('notify::visible', () => {
                        this._disconnectVisibleId(actor);
                        this._refreshVerticalAlloc();
                    });
                    actor._dtpDestroyId = actor.connect('destroy', () => this._disconnectVisibleId(actor));
                }

                if (child) {
                    let [, natWidth] = actor.get_preferred_width(-1);

                    child.x_align = Clutter.ActorAlign[isVertical ? 'CENTER' : 'START'];
                    actor.set_width(isVertical ? size : -1);
                    isVertical = isVertical && (natWidth > size);
                    actor[(isVertical ? 'add' : 'remove') + '_style_class_name']('vertical');
                }
            }

            actor.get_children().forEach(c => _set(c, isVertical));
        };

        _set(actor, false);
        _set(actor, isVertical);
    },

    _disconnectVisibleId: function(actor) {
        actor.disconnect(actor._dtpVisibleId);
        actor.disconnect(actor._dtpDestroyId);

        delete actor._dtpVisibleId;
        delete actor._dtpDestroyId;
        
        this._unmappedButtons.splice(this._unmappedButtons.indexOf(actor), 1);
    },

    _setAppmenuVisible: function(isVisible) {
        let parent;
        let appMenu = this.statusArea.appMenu;

        if(appMenu)
            parent = appMenu.container.get_parent();

        if (parent) {
            parent.remove_child(appMenu.container);
        }

        if (isVisible && appMenu) {
            this._leftBox.insert_child_above(appMenu.container, null);
        }
    },

    _formatVerticalClock: function() {
        // https://github.com/GNOME/gnome-desktop/blob/master/libgnome-desktop/gnome-wall-clock.c#L310
        if (this.statusArea.dateMenu) {
            let datetime = this.statusArea.dateMenu._clock.clock;
            let datetimeParts = datetime.split(' ');
            let time = datetimeParts[1];
            let clockText = this.statusArea.dateMenu._clockDisplay.clutter_text;
            let setClockText = text => {
                let stacks = text instanceof Array;
                let separator = '\n<span size="xx-small">‧‧</span>\n';
        
                clockText.set_text((stacks ? text.join(separator) : text).trim());
                clockText.set_use_markup(stacks);
                clockText.get_allocation_box();
        
                return !clockText.get_layout().is_ellipsized();
            };

            if (!time) {
                datetimeParts = datetime.split(' ');
                time = datetimeParts.pop();
                datetimeParts = [datetimeParts.join(' '), time];
            }

            if (!setClockText(datetime) && 
                !setClockText(datetimeParts) && 
                !setClockText(time)) {
                let timeParts = time.split('∶');

                if (!this._clockFormat) {
                    this._clockFormat = Me.desktopSettings.get_string('clock-format');
                }

                if (this._clockFormat == '12h') {
                    timeParts.push.apply(timeParts, timeParts.pop().split(' '));
                }

                setClockText(timeParts);
            }
        }
    },

    _setRightCornerStyle: function() {
        if (this.panel._rightCorner) {
            this._toggleCornerStyle(
                this.panel._rightCorner,
                (this.statusArea.aggregateMenu && 
                 this.panel.actor.get_last_child() == this.statusArea.aggregateMenu.container)
            );
        }
    },

    _toggleCornerStyle: function(corner, visible) {
        if (corner) {
            corner.actor[(visible ? 'remove' : 'add') + '_style_class_name']('hidden');
        }
    },

    _setShowDesktopButton: function (add) {
        if (add) {
            if(this._showDesktopButton)
                return;

            this._showDesktopButton = new St.Bin({ style_class: 'showdesktop-button',
                            reactive: true,
                            can_focus: true,
                            x_fill: true,
                            y_fill: true,
                            track_hover: true });

            this._setShowDesktopButtonSize();

            this._showDesktopButton.connect('button-press-event', () => this._onShowDesktopButtonPress());
            this._showDesktopButton.connect('enter-event', () => {
                this._showDesktopButton.add_style_class_name('showdesktop-button-hovered');

                if (Me.settings.get_boolean('show-showdesktop-hover')) {
                    this._timeoutsHandler.add([T4, Me.settings.get_int('show-showdesktop-delay'), () => {
                        this._hiddenDesktopWorkspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
                        this._toggleWorkspaceWindows(true, this._hiddenDesktopWorkspace);
                    }]);
                }
            });
            
            this._showDesktopButton.connect('leave-event', () => {
                this._showDesktopButton.remove_style_class_name('showdesktop-button-hovered');

                if (Me.settings.get_boolean('show-showdesktop-hover')) {
                    if (this._timeoutsHandler.getId(T4)) {
                        this._timeoutsHandler.remove(T4);
                    } else if (this._hiddenDesktopWorkspace) {
                        this._toggleWorkspaceWindows(false, this._hiddenDesktopWorkspace);
                    }
                 }
            });

            this.panel.actor.add_child(this._showDesktopButton);
        } else {
            if(!this._showDesktopButton)
                return;

            this.panel.actor.remove_child(this._showDesktopButton);
            this._showDesktopButton.destroy();
            this._showDesktopButton = null;
        }
    },

    _setShowDesktopButtonSize: function() {
        if (this._showDesktopButton) {
            let buttonSize = Me.settings.get_int('showdesktop-button-width') + 'px;';
            let isVertical = checkIfVertical();
            let sytle = isVertical ? 'border-top-width:1px;height:' + buttonSize : 'border-left-width:1px;width:' + buttonSize;
            
            this._showDesktopButton.set_style(sytle);
            this._showDesktopButton[(isVertical ? 'x' : 'y') + '_expand'] = true;
        }
    },

    _toggleWorkspaceWindows: function(hide, workspace) {
        let tweenOpts = {
            opacity: hide ? 0 : 255,
            time: Me.settings.get_int('show-showdesktop-time') * .001,
            transition: 'easeOutQuad'
        };

        workspace.list_windows().forEach(w => {
            if (!w.minimized) {
                Utils.animateWindowOpacity(w.get_compositor_private(), tweenOpts)
            }
        });
    },

    _onShowDesktopButtonPress: function() {
        let label = 'trackerFocusApp';

        this._signalsHandler.removeWithLabel(label);
        this._timeoutsHandler.remove(T5);

        if(this._restoreWindowList && this._restoreWindowList.length) {
            this._timeoutsHandler.remove(T4);

            let current_workspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
            let windows = current_workspace.list_windows();
            this._restoreWindowList.forEach(function(w) {
                if(windows.indexOf(w) > -1)
                    Main.activateWindow(w);
            });
            this._restoreWindowList = null;
        } else {
            let current_workspace = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace();
            let windows = current_workspace.list_windows().filter(function (w) {
                return w.showing_on_its_workspace() && !w.skip_taskbar;
            });
            windows = global.display.sort_windows_by_stacking(windows);

            windows.forEach(function(w) {
                w.minimize();
            });
            
            this._restoreWindowList = windows;

            this._timeoutsHandler.add([T5, 20, () => this._signalsHandler.addWithLabel(
                label, 
                [
                    tracker, 
                    'notify::focus-app', 
                    () => this._restoreWindowList = null
                ]
            )]);
        }

        Main.overview.hide();
    },

    _onPanelMouseScroll: function(actor, event) {
        let scrollAction = Me.settings.get_string('scroll-panel-action');
        let direction = Utils.getMouseScrollDirection(event);

        if (!this._checkIfIgnoredScrollSource(event.get_source()) && !this._timeoutsHandler.getId(T6)) {
            if (direction && scrollAction === 'SWITCH_WORKSPACE') {
                let args = [global.display];

                //gnome-shell < 3.30 needs an additional "screen" param
                global.screen ? args.push(global.screen) : 0;

                Main.wm._showWorkspaceSwitcher.apply(Main.wm, args.concat([0, { get_name: () => 'switch---' + direction }]));
            } else if (direction && scrollAction === 'CYCLE_WINDOWS') {
                let windows = this.taskbar.getAppInfos().reduce((ws, appInfo) => ws.concat(appInfo.windows), []);
                
                Utils.activateSiblingWindow(windows, direction);
            } else if (scrollAction === 'CHANGE_VOLUME' && !event.is_pointer_emulated()) {
                var proto = Volume.Indicator.prototype;
                var func = proto.vfunc_scroll_event || proto._onScrollEvent;
    
                func.call(Main.panel.statusArea.aggregateMenu._volume, 0, event);
            } else {
                return;
            }

            var scrollDelay = Me.settings.get_int('scroll-panel-delay');

            if (scrollDelay) {
                this._timeoutsHandler.add([T6, scrollDelay, () => {}]);
            }
        }
    },

    _checkIfIgnoredScrollSource: function(source) {
        let ignoredConstr = ['WorkspaceIndicator'];

        return source._dtpIgnoreScroll || ignoredConstr.indexOf(source.constructor.name) >= 0;
    },

    _initProgressManager: function() {
        if(!this.progressManager && (Me.settings.get_boolean('progress-show-bar') || Me.settings.get_boolean('progress-show-count')))
            this.progressManager = new Progress.ProgressManager();
    },
});

var dtpSecondaryAggregateMenu = Utils.defineClass({
    Name: 'dtpSecondaryAggregateMenu',
    Extends: PanelMenu.Button,

    _init: function() {
        this.callParent('_init', 0.0, C_("System menu in the top bar", "System"), false);

        Utils.wrapActor(this);

        this.menu.actor.add_style_class_name('aggregate-menu');

        let menuLayout = new Panel.AggregateLayout();
        this.menu.box.set_layout_manager(menuLayout);

        this._indicators = new St.BoxLayout({ style_class: 'panel-status-indicators-box' });
        this.actor.add_child(this._indicators);

        if (Config.HAVE_NETWORKMANAGER && Config.PACKAGE_VERSION >= '3.24') {
            this._network = new imports.ui.status.network.NMApplet();
        } else {
            this._network = null;
        }
        if (Config.HAVE_BLUETOOTH) {
            this._bluetooth = new imports.ui.status.bluetooth.Indicator();
        } else {
            this._bluetooth = null;
        }

        this._power = new imports.ui.status.power.Indicator();
        this._volume = new imports.ui.status.volume.Indicator();
        this._brightness = new imports.ui.status.brightness.Indicator();
        this._system = new imports.ui.status.system.Indicator();
        this._screencast = new imports.ui.status.screencast.Indicator();
        
        if (Config.PACKAGE_VERSION >= '3.24') {
            this._nightLight = new imports.ui.status.nightLight.Indicator();
        }

        if (Config.PACKAGE_VERSION >= '3.28') {
            this._thunderbolt = new imports.ui.status.thunderbolt.Indicator();
        }

        if (this._thunderbolt) {
            this._indicators.add_child(Utils.getIndicators(this._thunderbolt));
        }
        this._indicators.add_child(Utils.getIndicators(this._screencast));
        if (this._nightLight) {
            this._indicators.add_child(Utils.getIndicators(this._nightLight));
        }
        if (this._network) {
            this._indicators.add_child(Utils.getIndicators(this._network));
        }
        if (this._bluetooth) {
            this._indicators.add_child(Utils.getIndicators(this._bluetooth));
        }
        this._indicators.add_child(Utils.getIndicators(this._volume));
        this._indicators.add_child(Utils.getIndicators(this._power));
        this._indicators.add_child(PopupMenu.arrowIcon(St.Side.BOTTOM));

        this.menu.addMenuItem(this._volume.menu);
        this._volume._volumeMenu._readOutput();
        this._volume._volumeMenu._readInput();
        
        this.menu.addMenuItem(this._brightness.menu);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._network) {
            this.menu.addMenuItem(this._network.menu);
        }
        if (this._bluetooth) {
            this.menu.addMenuItem(this._bluetooth.menu);
        }
        this.menu.addMenuItem(this._power.menu);
        this._power._sync();

        if (this._nightLight) {
            this.menu.addMenuItem(this._nightLight.menu);
        }
        this.menu.addMenuItem(this._system.menu);

        menuLayout.addSizeChild(this._power.menu.actor);
        menuLayout.addSizeChild(this._system.menu.actor);
    },
});
