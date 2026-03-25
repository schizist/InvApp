// Built-in single-user catalog so the app can run on first launch without backend access.
(function(global){
  const DEFAULT_ITEMS = [
    { id: 'mold_112', label: 'M-112', category: 'mold' },
    { id: 'mold_157', label: 'M-157', category: 'mold' },
    { id: 'mold_157-4', label: 'M-157-4', category: 'mold' },
    { id: 'mold_157-8', label: 'M-157-8', category: 'mold' },
    { id: 'mold_157-12', label: 'M-157-12', category: 'mold' },
    { id: 'mold_157-16', label: 'M-157-16', category: 'mold' },
    { id: 'mold_157-24', label: 'M-157-24', category: 'mold' },
    { id: 'mold_159', label: 'M-159', category: 'mold' },
    { id: 'mold_161', label: 'M-161', category: 'mold' },
    { id: 'mold_161-16', label: 'M-161-16', category: 'mold' },
    { id: 'mold_161-20', label: 'M-161-20', category: 'mold' },
    { id: 'mold_161-24', label: 'M-161-24', category: 'mold' },
    { id: 'wire_10', label: '#10 Wire', category: 'wire' },
    { id: 'wire_8', label: '#8 Wire', category: 'wire' },
    { id: 'wire_6', label: '#6 Wire', category: 'wire' },
    { id: 'wire_4', label: '#4 Wire', category: 'wire' },
    { id: 'wire_2', label: '#2 Wire', category: 'wire' },
    { id: 'wire_8_nsf', label: '#8 NSF Wire', category: 'wire' },
    { id: 'shot_25_ci', label: '25 CI', category: 'shot' },
    { id: 'shot_25_cp', label: '25 CP', category: 'shot' },
    { id: 'shot_45_ci', label: '45 CI', category: 'shot' },
    { id: 'shot_45_cp', label: '45 CP', category: 'shot' },
    { id: 'cap_pc', label: 'ThermoCap', category: 'cap' },
    { id: 'enclosure_fink_blue', label: 'Blue Fink', category: 'enclosure' },
    { id: 'enclosure_fink_blue_steel', label: 'Blue Steel Fink', category: 'enclosure' },
    { id: 'enclosure_fink_purple', label: 'Purple Fink', category: 'enclosure' },
    { id: 'enclosure_g05', label: 'G05', category: 'enclosure' },
    { id: 'anode_hp_mag', label: 'HP Mag Anode', category: 'anode' },
    { id: 'SRE-002', label: 'Stelth Cu-CuSO', category: 'refcell' }
  ];

  global.INVAPP_DEFAULT_ITEMS = DEFAULT_ITEMS.slice();
})(window);
